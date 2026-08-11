//! RoutaOrchestrator - Task orchestration and child agent spawning.
//!
//! Port of the TypeScript RoutaOrchestrator from src/core/orchestration/orchestrator.ts
//!
//! The orchestrator bridges MCP tool calls with actual ACP process spawning:
//!   1. Creates a child agent record
//!   2. Spawns a real ACP process for the child agent
//!   3. Sends the task as the initial prompt
//!   4. Subscribes for completion events
//!   5. When the child reports back, wakes the parent agent

pub mod team_chain;
pub mod team_run_ownership;

pub use team_chain::{
    build_team_chain_policy_prompt, is_team_chain_id, parse_team_chain_id,
    resolve_effective_team_chain_id, validate_team_chain_assignment, TeamChainValidationError,
    DEFAULT_TEAM_CHAIN_ID, TEAM_CHAIN_IDS, TEAM_LEAD_SPECIALIST_ID,
};
pub use team_run_ownership::{resolve_owning_team_run_id, OwnershipSessionShape};

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::acp::AcpManager;
use crate::error::ServerError;
use crate::events::{AgentEvent, AgentEventType, EventBus};
use crate::kanban::{apply_task_status_transition, load_task_board};
use crate::models::agent::{AgentRole, AgentStatus, ModelTier};
use crate::models::build_feature_tree_spec_prompt_section;
use crate::models::task::TaskStatus;
use crate::store::{AgentStore, KanbanStore, TaskStore};
use crate::tools::{CompletionReport, ToolResult};
use crate::workflow::specialist::{SpecialistDef, SpecialistLoader};

// ─── Specialist Configuration ─────────────────────────────────────────────

/// Specialist configuration for agent roles.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecialistConfig {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub role: AgentRole,
    pub default_model_tier: ModelTier,
    pub system_prompt: String,
    pub role_reminder: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_adapter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
}

impl SpecialistConfig {
    pub fn system_prompt_body(&self) -> Option<String> {
        if self.system_prompt.trim().is_empty() {
            return None;
        }

        let mut prompt = self.system_prompt.trim().to_string();

        if self.id == "feature-surface-metadata-analyst" {
            prompt.push_str("\n\n---\n\n");
            prompt.push_str(&build_feature_tree_spec_prompt_section());
        }

        Some(prompt)
    }

    pub fn system_prompt_with_reminder(&self) -> Option<String> {
        let mut prompt = self.system_prompt_body()?;

        if !self.role_reminder.trim().is_empty() {
            prompt.push_str("\n\n---\n**Reminder:** ");
            prompt.push_str(self.role_reminder.trim());
            prompt.push('\n');
        }

        Some(prompt)
    }

    /// Get the CRAFTER specialist config.
    pub fn crafter() -> Self {
        Self {
            id: "crafter".to_string(),
            name: "Implementor".to_string(),
            description: Some("Executes implementation tasks, writes code".to_string()),
            role: AgentRole::Crafter,
            default_model_tier: ModelTier::Fast,
            system_prompt: CRAFTER_SYSTEM_PROMPT.to_string(),
            role_reminder: CRAFTER_ROLE_REMINDER.to_string(),
            default_provider: None,
            default_adapter: None,
            default_model: None,
        }
    }

    /// Get the GATE specialist config.
    pub fn gate() -> Self {
        Self {
            id: "gate".to_string(),
            name: "Verifier".to_string(),
            description: Some("Reviews work and verifies completeness".to_string()),
            role: AgentRole::Gate,
            default_model_tier: ModelTier::Smart,
            system_prompt: GATE_SYSTEM_PROMPT.to_string(),
            role_reminder: GATE_ROLE_REMINDER.to_string(),
            default_provider: None,
            default_adapter: None,
            default_model: None,
        }
    }

    /// Get the DEVELOPER specialist config.
    pub fn developer() -> Self {
        Self {
            id: "developer".to_string(),
            name: "Developer".to_string(),
            description: Some("Plans then implements itself".to_string()),
            role: AgentRole::Developer,
            default_model_tier: ModelTier::Smart,
            system_prompt: DEVELOPER_SYSTEM_PROMPT.to_string(),
            role_reminder: DEVELOPER_ROLE_REMINDER.to_string(),
            default_provider: None,
            default_adapter: None,
            default_model: None,
        }
    }

    /// Get specialist by role.
    pub fn by_role(role: &AgentRole) -> Option<Self> {
        match role {
            AgentRole::Crafter => Some(Self::crafter()),
            AgentRole::Gate => Some(Self::gate()),
            AgentRole::Developer => Some(Self::developer()),
            AgentRole::Routa => None, // Coordinator doesn't delegate to itself
        }
    }

    /// Get specialist by ID.
    pub fn by_id(id: &str) -> Option<Self> {
        match id.to_lowercase().as_str() {
            "crafter" => Some(Self::crafter()),
            "backend-dev" => Some(Self::crafter()),
            "backend" => Some(Self::crafter()),
            "frontend-dev" => Some(Self::crafter()),
            "frontend" => Some(Self::crafter()),
            "general-engineer" => Some(Self::crafter()),
            "operations" => Some(Self::crafter()),
            "ops" => Some(Self::crafter()),
            "gate" => Some(Self::gate()),
            "qa" => Some(Self::gate()),
            "qa-specialist" => Some(Self::gate()),
            "code-reviewer" => Some(Self::gate()),
            "reviewer" => Some(Self::gate()),
            "developer" => Some(Self::developer()),
            "researcher" => Some(Self::developer()),
            "ux-designer" => Some(Self::developer()),
            _ => None,
        }
    }

    pub fn from_specialist_def(def: SpecialistDef) -> Option<Self> {
        let role_name = def.role.to_ascii_uppercase();
        let role = AgentRole::from_str(&role_name)?;
        let model_tier = match def.model_tier.to_ascii_uppercase().as_str() {
            "FAST" => ModelTier::Fast,
            "BALANCED" => ModelTier::Balanced,
            _ => ModelTier::Smart,
        };

        Some(Self {
            id: def.id,
            name: def.name,
            description: def.description,
            role,
            default_model_tier: model_tier,
            system_prompt: def.system_prompt,
            role_reminder: def.role_reminder.unwrap_or_default(),
            default_provider: def.default_provider,
            default_adapter: def.default_adapter,
            default_model: def.default_model,
        })
    }

    pub fn list_available() -> Vec<Self> {
        let mut specialists = HashMap::new();

        for specialist in [Self::developer(), Self::crafter(), Self::gate()] {
            specialists.insert(specialist.id.clone(), specialist);
        }

        let mut loader = SpecialistLoader::new();
        loader.load_default_dirs();

        for specialist in loader
            .all()
            .values()
            .cloned()
            .filter_map(Self::from_specialist_def)
        {
            specialists.insert(specialist.id.clone(), specialist);
        }

        let mut values: Vec<_> = specialists.into_values().collect();
        values.sort_by(|left, right| left.id.cmp(&right.id));
        values
    }

    pub fn resolve(input: &str) -> Option<Self> {
        if let Some(role) = AgentRole::from_str(input) {
            return Self::by_role(&role);
        }

        let target = input.to_lowercase();

        if let Some(alias) = Self::by_id(&target) {
            return Some(alias);
        }

        Self::list_available()
            .into_iter()
            .find(|specialist| specialist.id == target)
    }
}

// ─── System Prompts (Hardcoded Fallbacks) ─────────────────────────────────

const CRAFTER_SYSTEM_PROMPT: &str = r#"## Crafter (Implementor)

Implement your assigned task — nothing more, nothing less. Produce minimal, clean changes.

## Hard Rules
1. **No scope creep** — only what the task asks
2. **No refactors** — if needed, report to parent for a separate task
3. **Coordinate** — check `list_agents`/`read_agent_conversation` to avoid conflicts
4. **Notes only** — don't create markdown files for collaboration
5. **Don't delegate** — message parent coordinator if blocked

## Completion (REQUIRED)
When done, you MUST call `report_to_parent` with:
- summary: 1-3 sentences of what you did
- success: true/false
- filesModified: list of files you changed
- taskId: the task ID you were assigned
"#;

const CRAFTER_ROLE_REMINDER: &str =
    "Stay within task scope. No refactors, no scope creep. Call report_to_parent when complete.";

const GATE_SYSTEM_PROMPT: &str = r#"## Gate (Verifier)

You verify the implementation against the spec's **Acceptance Criteria**.
You are evidence-driven: if you can't point to concrete evidence, it's not verified.

## Hard Rules
1) **Acceptance Criteria is the checklist.** Do not verify against vibes.
2) **No evidence, no verification.** If you can't cite evidence, mark ⚠️ or ❌.
3) **No partial approvals.** "APPROVED" only if every criterion is ✅ VERIFIED.

## Completion (REQUIRED)
Call `report_to_parent` with:
- summary: verdict + confidence, tests run, top 1-3 issues
- success: true only if ALL criteria are VERIFIED
- taskId: the task ID you were verifying
"#;

const GATE_ROLE_REMINDER: &str =
    "Verify against Acceptance Criteria ONLY. Be evidence-driven. Call report_to_parent with verdict.";

const DEVELOPER_SYSTEM_PROMPT: &str = r#"## Developer

You plan and implement. You write specs first, then implement the work yourself after approval.

## Hard Rules
1. **Spec first, always** — Create/update the spec BEFORE any implementation.
2. **Wait for approval** — Present the plan and STOP. Wait for user approval.
3. **No delegation** — Never use `delegate_task` or `create_agent`.
"#;

const DEVELOPER_ROLE_REMINDER: &str =
    "You work ALONE — never use delegate_task or create_agent. Spec first, wait for approval.";

// ─── Delegation Parameters ────────────────────────────────────────────────

/// Parameters for delegating a task with agent spawning.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegateWithSpawnParams {
    /// Task ID to delegate
    pub task_id: String,
    /// Calling agent's ID
    pub caller_agent_id: String,
    /// Calling agent's session ID (for wake-up)
    pub caller_session_id: String,
    /// Workspace ID
    pub workspace_id: String,
    /// Specialist role: "CRAFTER", "GATE", "DEVELOPER"
    pub specialist: String,
    /// ACP provider to use for the child
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Working directory for the child agent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Additional instructions beyond the task content
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additional_instructions: Option<String>,
    /// Wait mode: "immediate" or "after_all"
    #[serde(default = "default_wait_mode")]
    pub wait_mode: String,
}

fn default_wait_mode() -> String {
    "immediate".to_string()
}

/// Orchestrator configuration.
#[derive(Debug, Clone)]
pub struct OrchestratorConfig {
    /// Default ACP provider for CRAFTER agents
    pub default_crafter_provider: String,
    /// Default ACP provider for GATE agents
    pub default_gate_provider: String,
    /// Default working directory
    pub default_cwd: String,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            default_crafter_provider: "opencode".to_string(),
            default_gate_provider: "opencode".to_string(),
            default_cwd: ".".to_string(),
        }
    }
}

// ─── Child Agent Record ───────────────────────────────────────────────────

/// Tracks a spawned child agent and its relationship to a parent.
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct ChildAgentRecord {
    agent_id: String,
    session_id: String,
    parent_agent_id: String,
    parent_session_id: String,
    task_id: String,
    role: AgentRole,
    provider: String,
}

/// Delegation group for wait_mode="after_all"
#[derive(Debug)]
struct DelegationGroup {
    #[allow(dead_code)]
    group_id: String,
    parent_agent_id: String,
    parent_session_id: String,
    child_agent_ids: Vec<String>,
    completed_agent_ids: HashSet<String>,
}

// ─── Orchestrator Inner State ─────────────────────────────────────────────

struct OrchestratorInner {
    /// Map: agentId → ChildAgentRecord
    child_agents: HashMap<String, ChildAgentRecord>,
    /// Map: agentId → sessionId
    agent_session_map: HashMap<String, String>,
    /// Map: groupId → DelegationGroup
    delegation_groups: HashMap<String, DelegationGroup>,
    /// Map: callerAgentId → current groupId (for after_all mode)
    active_group_by_agent: HashMap<String, String>,
    /// Per-task delegation guards: concurrent delegation requests for the same
    /// task are serialized through this mutex instead of racing for the binding.
    task_delegation_guards: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
}

/// An active delegation binding that can be reused instead of spawning a
/// duplicate agent/session for the same task.
struct ActiveDelegationBinding {
    agent_id: String,
    session_id: String,
    agent_name: Option<String>,
    specialist_id: Option<String>,
    specialist_name: Option<String>,
    provider: Option<String>,
}

/// Append a delegation child session id to the task's session history, deduped.
fn append_delegation_session_id(session_ids: &[String], session_id: &str) -> Vec<String> {
    let mut next = session_ids.to_vec();
    if !next.iter().any(|existing| existing == session_id) {
        next.push(session_id.to_string());
    }
    next
}

/// Build the canonical delegation tool result. Kept field-compatible with the
/// Web orchestrator's `buildDelegatedResult`: `taskId`/`agentId`/`sessionId`
/// plus the additive `status: "delegated"` marker.
#[allow(clippy::too_many_arguments)]
fn build_delegated_result(
    task_title: &str,
    task_id: &str,
    agent_id: &str,
    agent_name: Option<&str>,
    specialist_id: &str,
    specialist_name: Option<&str>,
    provider: Option<&str>,
    session_id: &str,
    wait_mode: &str,
    reused: bool,
) -> ToolResult {
    let wait_message = if wait_mode == "after_all" {
        "You will be notified when ALL delegated agents in this group complete."
    } else {
        "You will be notified when this agent completes."
    };
    let specialist_label = specialist_name.unwrap_or(specialist_id);
    let message = if reused {
        format!(
            "Task \"{task_title}\" is already delegated to an active {specialist_label} agent. {wait_message}"
        )
    } else {
        format!("Task \"{task_title}\" delegated to {specialist_label} agent. {wait_message}")
    };

    let mut data = serde_json::json!({
        "agentId": agent_id,
        "taskId": task_id,
        "specialist": specialist_id,
        "sessionId": session_id,
        "waitMode": wait_mode,
        "status": "delegated",
        "message": message,
    });
    if let Some(name) = agent_name {
        data["agentName"] = serde_json::json!(name);
    }
    if let Some(provider) = provider {
        data["provider"] = serde_json::json!(provider);
    }
    ToolResult::success(data)
}

// ─── Routa Orchestrator ───────────────────────────────────────────────────

/// The core orchestration engine that bridges MCP tool calls with ACP process spawning.
pub struct RoutaOrchestrator {
    inner: Arc<RwLock<OrchestratorInner>>,
    config: OrchestratorConfig,
    acp_manager: Arc<AcpManager>,
    agent_store: AgentStore,
    task_store: TaskStore,
    kanban_store: KanbanStore,
    event_bus: EventBus,
}

impl RoutaOrchestrator {
    pub fn new(
        config: OrchestratorConfig,
        acp_manager: Arc<AcpManager>,
        agent_store: AgentStore,
        task_store: TaskStore,
        kanban_store: KanbanStore,
        event_bus: EventBus,
    ) -> Self {
        Self {
            inner: Arc::new(RwLock::new(OrchestratorInner {
                child_agents: HashMap::new(),
                agent_session_map: HashMap::new(),
                delegation_groups: HashMap::new(),
                active_group_by_agent: HashMap::new(),
                task_delegation_guards: HashMap::new(),
            })),
            config,
            acp_manager,
            agent_store,
            task_store,
            kanban_store,
            event_bus,
        }
    }

    /// Register the mapping between an agent ID and its ACP session ID.
    pub async fn register_agent_session(&self, agent_id: &str, session_id: &str) {
        let mut inner = self.inner.write().await;
        inner
            .agent_session_map
            .insert(agent_id.to_string(), session_id.to_string());
        tracing::info!(
            "[Orchestrator] Registered agent session: {} → {}",
            agent_id,
            session_id
        );
    }

    /// Get the session ID for an agent.
    pub async fn get_session_for_agent(&self, agent_id: &str) -> Option<String> {
        let inner = self.inner.read().await;
        inner.agent_session_map.get(agent_id).cloned()
    }

    /// Delegate a task to a new agent by spawning a real ACP process.
    ///
    /// Concurrency and persistence contract (mirrors the Web orchestrator):
    /// 1. per-task in-flight guard serializes concurrent requests;
    /// 2. the task is re-read inside the guard;
    /// 3. an existing active binding is reused without duplicates;
    /// 4. the pending agent and child session are created BEFORE the binding
    ///    persists, but the initial prompt is NOT sent yet;
    /// 5. the binding save writes `assigned_to`, deduped `session_ids`,
    ///    `team_run_id` and `IN_PROGRESS` without touching `session_id`;
    /// 6. only after the save succeeds the agent is activated and prompted;
    /// 7. a failed binding save never returns success.
    pub async fn delegate_task_with_spawn(
        &self,
        params: DelegateWithSpawnParams,
    ) -> Result<ToolResult, ServerError> {
        // 1. Resolve specialist config
        let specialist_config = match self.resolve_specialist(&params.specialist) {
            Some(config) => config,
            None => {
                return Ok(ToolResult::error(format!(
                    "Unknown specialist: {}. Use CRAFTER, GATE, or DEVELOPER.",
                    params.specialist
                )));
            }
        };

        // 2. Serialize concurrent delegation attempts for the same task.
        let guard = {
            let mut inner = self.inner.write().await;
            inner
                .task_delegation_guards
                .entry(params.task_id.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };

        let result = {
            let _permit = guard.lock().await;
            self.execute_task_delegation(&params, &specialist_config)
                .await
        };

        // Drop the guard entry once no other request is queued on it (a
        // waiter always holds its own Arc clone, keeping strong_count > 2).
        {
            let mut inner = self.inner.write().await;
            let removable = inner
                .task_delegation_guards
                .get(&params.task_id)
                .is_some_and(|existing| Arc::ptr_eq(existing, &guard))
                && Arc::strong_count(&guard) == 2;
            if removable {
                inner.task_delegation_guards.remove(&params.task_id);
            }
        }

        result
    }

    /// Delegation body executed under the per-task guard.
    async fn execute_task_delegation(
        &self,
        params: &DelegateWithSpawnParams,
        specialist_config: &SpecialistConfig,
    ) -> Result<ToolResult, ServerError> {
        let task_id = params.task_id.as_str();

        // 1. Re-read the task inside the guard: its state may have changed
        //    between the caller's last read and this serialized section.
        let task = match self.task_store.get(task_id).await? {
            Some(task) => task,
            None => {
                return Ok(ToolResult::error(format!("Task not found: {task_id}")));
            }
        };

        // 2. Reuse an existing active delegation binding instead of spawning
        //    a duplicate agent/session for the same task.
        if let Some(existing) = self.resolve_active_delegation_binding(&task).await? {
            return Ok(build_delegated_result(
                &task.title,
                task_id,
                &existing.agent_id,
                existing.agent_name.as_deref(),
                existing
                    .specialist_id
                    .as_deref()
                    .unwrap_or(&specialist_config.id),
                existing.specialist_name.as_deref(),
                existing.provider.as_deref(),
                &existing.session_id,
                &params.wait_mode,
                true,
            ));
        }

        // 3. Determine provider and working directory
        let provider = params.provider.clone().unwrap_or_else(|| {
            if specialist_config.role == AgentRole::Crafter {
                self.config.default_crafter_provider.clone()
            } else {
                self.config.default_gate_provider.clone()
            }
        });
        let cwd = params
            .cwd
            .clone()
            .unwrap_or_else(|| self.config.default_cwd.clone());

        // 4. Create agent record (PENDING until the binding is saved)
        let agent_id = uuid::Uuid::new_v4().to_string();
        let agent_name = format!(
            "{}-{}",
            specialist_config.id,
            task.title
                .chars()
                .take(30)
                .collect::<String>()
                .replace(' ', "-")
                .to_lowercase()
        );
        let mut agent_metadata = HashMap::new();
        agent_metadata.insert("specialist".to_string(), specialist_config.id.clone());
        let agent = crate::models::agent::Agent::new(
            agent_id.clone(),
            agent_name.clone(),
            specialist_config.role.clone(),
            params.workspace_id.clone(),
            Some(params.caller_agent_id.clone()),
            Some(specialist_config.default_model_tier.clone()),
            Some(agent_metadata),
        );
        self.agent_store.save(&agent).await?;

        // 5. Build the delegation prompt
        let delegation_prompt = build_delegation_prompt(
            specialist_config,
            &agent_id,
            task_id,
            &task.title,
            &task.objective,
            task.scope.as_deref(),
            task.acceptance_criteria.as_ref(),
            task.verification_commands.as_ref(),
            task.test_cases.as_ref(),
            &params.caller_agent_id,
            params.additional_instructions.as_deref(),
        );

        // 6. Create the child session BEFORE persisting the binding, but do
        //    not dispatch the initial prompt yet: the prompt may only be sent
        //    after the binding is durable.
        let child_session_id = uuid::Uuid::new_v4().to_string();
        if let Err(error) = self
            .acp_manager
            .create_session(
                child_session_id.clone(),
                cwd,
                params.workspace_id.clone(),
                Some(provider.clone()),
                Some(specialist_config.role.as_str().to_string()),
                None,
                Some(params.caller_session_id.clone()), // parent_session_id
                None,
                None,
            )
            .await
        {
            // The binding was never persisted: fail the fresh agent and leave
            // the task in its previous state.
            self.agent_store
                .update_status(&agent_id, &AgentStatus::Error)
                .await?;
            return Ok(ToolResult::error(format!(
                "Failed to spawn agent process: {error}"
            )));
        }

        // 7. Persist the binding before activating the child. The per-task
        // guard serializes delegates inside this orchestrator instance.
        let team_run_id = match task.team_run_id.clone() {
            Some(run_id) => Some(run_id),
            None => {
                self.resolve_team_run_id_for_caller(&params.caller_session_id)
                    .await
            }
        };
        let session_ids = append_delegation_session_id(&task.session_ids, &child_session_id);
        let mut task = task;
        task.assigned_to = Some(agent_id.clone());
        task.status = TaskStatus::InProgress;
        task.session_ids = session_ids;
        if team_run_id.is_some() {
            task.team_run_id = team_run_id;
        }
        task.updated_at = Utc::now();
        if let Err(error) = self.task_store.save(&task).await {
            self.release_unbound_child_resources(&agent_id, &child_session_id)
                .await;
            return Ok(ToolResult::error(format!(
                "Failed to persist delegation binding for task {task_id}: {error}"
            )));
        }

        // 8. Activate + dispatch ONLY after the binding persists.
        self.agent_store
            .update_status(&agent_id, &AgentStatus::Active)
            .await?;

        if !self.acp_manager.is_alive(&child_session_id).await {
            // Keep the session for diagnostics: block the task through the
            // unified status transition and mark the agent failed.
            self.agent_store
                .update_status(&agent_id, &AgentStatus::Error)
                .await?;
            if let Some(mut current) = self.task_store.get(task_id).await? {
                if current.assigned_to.as_deref() == Some(agent_id.as_str())
                    && current.session_ids.contains(&child_session_id)
                    && current.status == TaskStatus::InProgress
                {
                    let board = load_task_board(&self.kanban_store, &current).await;
                    apply_task_status_transition(&mut current, TaskStatus::Blocked, board.as_ref());
                    self.task_store.save(&current).await?;
                }
            }
            return Ok(ToolResult::error(format!(
                "Failed to start agent process: child session {child_session_id} is not available"
            )));
        }

        // Kick off the child prompt in the background. Waiting for the entire
        // child turn here blocks the parent MCP tool call long enough for
        // OpenCode to abort delegation before the child can report progress.
        self.acp_manager
            .mark_first_prompt_sent(&child_session_id)
            .await;
        let child_prompt_manager = Arc::clone(&self.acp_manager);
        let child_prompt_agent_store = self.agent_store.clone();
        let child_prompt_task_store = self.task_store.clone();
        let child_prompt_kanban_store = self.kanban_store.clone();
        let child_prompt_session_id = child_session_id.clone();
        let child_prompt_agent_id = agent_id.clone();
        let child_prompt_task_id = task.id.clone();
        tokio::spawn(async move {
            if let Err(error) = child_prompt_manager
                .prompt(&child_prompt_session_id, &delegation_prompt)
                .await
            {
                tracing::error!(
                    "[Orchestrator] Failed to send initial prompt to agent {}: {}",
                    child_prompt_agent_id,
                    error
                );
                // Compensate while the delegation is still in its initial
                // state: keep the session for diagnostics, mark the agent
                // failed, and block the task via the unified transition.
                if let Ok(Some(agent)) = child_prompt_agent_store.get(&child_prompt_agent_id).await
                {
                    if agent.status == AgentStatus::Active {
                        let _ = child_prompt_agent_store
                            .update_status(&child_prompt_agent_id, &AgentStatus::Error)
                            .await;
                    }
                }
                if let Ok(Some(mut blocked_task)) =
                    child_prompt_task_store.get(&child_prompt_task_id).await
                {
                    if blocked_task.status == TaskStatus::InProgress {
                        let board =
                            load_task_board(&child_prompt_kanban_store, &blocked_task).await;
                        apply_task_status_transition(
                            &mut blocked_task,
                            TaskStatus::Blocked,
                            board.as_ref(),
                        );
                        let _ = child_prompt_task_store.save(&blocked_task).await;
                    }
                }
            }
        });

        self.acp_manager
            .push_to_history(
                &child_session_id,
                serde_json::json!({
                    "sessionId": child_session_id,
                    "update": {
                        "sessionUpdate": "agent_message",
                        "content": {
                            "type": "text",
                            "text": format!(
                                "Delegated task '{}' to child agent {}. Child session launched and awaiting transcript updates.",
                                task.title, agent_name
                            )
                        }
                    }
                }),
            )
            .await;

        // 9. Track the child agent
        {
            let mut inner = self.inner.write().await;
            let record = ChildAgentRecord {
                agent_id: agent_id.clone(),
                session_id: child_session_id.clone(),
                parent_agent_id: params.caller_agent_id.clone(),
                parent_session_id: params.caller_session_id.clone(),
                task_id: params.task_id.clone(),
                role: specialist_config.role.clone(),
                provider: provider.clone(),
            };
            inner.child_agents.insert(agent_id.clone(), record);
            inner
                .agent_session_map
                .insert(agent_id.clone(), child_session_id.clone());

            // 10. Handle wait mode
            if params.wait_mode == "after_all" {
                let group_id = inner
                    .active_group_by_agent
                    .get(&params.caller_agent_id)
                    .cloned();

                let group_id = match group_id {
                    Some(gid) => gid,
                    None => {
                        let new_group_id = format!("delegation-group-{}", uuid::Uuid::new_v4());
                        inner
                            .active_group_by_agent
                            .insert(params.caller_agent_id.clone(), new_group_id.clone());
                        inner.delegation_groups.insert(
                            new_group_id.clone(),
                            DelegationGroup {
                                group_id: new_group_id.clone(),
                                parent_agent_id: params.caller_agent_id.clone(),
                                parent_session_id: params.caller_session_id.clone(),
                                child_agent_ids: Vec::new(),
                                completed_agent_ids: HashSet::new(),
                            },
                        );
                        new_group_id
                    }
                };

                if let Some(group) = inner.delegation_groups.get_mut(&group_id) {
                    group.child_agent_ids.push(agent_id.clone());
                }
            }
        }

        // 11. Emit event
        self.event_bus
            .emit(AgentEvent {
                event_type: AgentEventType::TaskAssigned,
                agent_id: agent_id.clone(),
                workspace_id: params.workspace_id.clone(),
                data: serde_json::json!({
                    "taskId": params.task_id,
                    "callerAgentId": params.caller_agent_id,
                    "taskTitle": task.title,
                    "provider": provider,
                    "specialist": specialist_config.id,
                }),
                timestamp: Utc::now(),
            })
            .await;

        tracing::info!(
            "[Orchestrator] Delegated task \"{}\" to {} agent {} (provider: {})",
            task.title,
            specialist_config.name,
            agent_id,
            provider
        );

        Ok(build_delegated_result(
            &task.title,
            task_id,
            &agent_id,
            Some(&agent_name),
            &specialist_config.id,
            Some(&specialist_config.name),
            Some(provider.as_str()),
            &child_session_id,
            &params.wait_mode,
            false,
        ))
    }

    /// Resolve a still-active delegation binding for a task, when one exists:
    /// assigned agent ACTIVE plus either a live runtime child record or a live
    /// delegated session from the task's session history.
    async fn resolve_active_delegation_binding(
        &self,
        task: &crate::models::task::Task,
    ) -> Result<Option<ActiveDelegationBinding>, ServerError> {
        let Some(agent_id) = task.assigned_to.clone() else {
            return Ok(None);
        };
        if task.status != TaskStatus::InProgress {
            return Ok(None);
        }
        let Some(agent) = self.agent_store.get(&agent_id).await? else {
            return Ok(None);
        };
        if agent.status != AgentStatus::Active {
            return Ok(None);
        }

        let specialist_id = agent.metadata.get("specialist").cloned();
        let specialist_name = specialist_id
            .as_deref()
            .and_then(SpecialistConfig::resolve)
            .map(|config| config.name);

        // A live runtime record wins: it tracks the session this orchestrator
        // actually spawned for the binding.
        {
            let inner = self.inner.read().await;
            if let Some(record) = inner.child_agents.get(&agent_id) {
                return Ok(Some(ActiveDelegationBinding {
                    agent_id,
                    agent_name: Some(agent.name.clone()),
                    specialist_id,
                    specialist_name,
                    session_id: record.session_id.clone(),
                    provider: Some(record.provider.clone()),
                }));
            }
        }

        // Otherwise fall back to the most recent delegated session that is
        // still alive, walking the session history newest-first.
        for session_id in task.session_ids.iter().rev() {
            if !self.acp_manager.is_alive(session_id).await {
                continue;
            }
            let provider = self
                .acp_manager
                .get_session(session_id)
                .await
                .and_then(|record| record.provider);
            return Ok(Some(ActiveDelegationBinding {
                agent_id,
                agent_name: Some(agent.name.clone()),
                specialist_id,
                specialist_name,
                session_id: session_id.clone(),
                provider,
            }));
        }

        Ok(None)
    }

    /// Best-effort resolution of the owning Team Run for the caller session.
    /// Never blocks delegation: failures resolve to `None`.
    async fn resolve_team_run_id_for_caller(&self, caller_session_id: &str) -> Option<String> {
        if caller_session_id.is_empty() {
            return None;
        }
        let records = self.acp_manager.list_sessions().await;
        let sessions: Vec<OwnershipSessionShape> =
            records.iter().map(OwnershipSessionShape::from).collect();
        resolve_owning_team_run_id(Some(caller_session_id), &sessions)
    }

    /// Clean up resources created before the task binding was persisted.
    async fn release_unbound_child_resources(&self, agent_id: &str, session_id: &str) {
        self.acp_manager.kill_session(session_id).await;
        if let Err(error) = self
            .agent_store
            .update_status(agent_id, &AgentStatus::Error)
            .await
        {
            tracing::warn!(
                "[Orchestrator] Failed to mark unbound agent {} as ERROR: {}",
                agent_id,
                error
            );
        }
    }

    /// Handle a report submitted by a child agent.
    pub async fn handle_report_submitted(
        &self,
        child_agent_id: &str,
        report: &CompletionReport,
    ) -> Result<(), ServerError> {
        let record = {
            let inner = self.inner.read().await;
            inner.child_agents.get(child_agent_id).cloned()
        };

        let record = match record {
            Some(r) => r,
            None => {
                tracing::warn!(
                    "[Orchestrator] Report from unknown child agent {}, ignoring",
                    child_agent_id
                );
                return Ok(());
            }
        };

        // Update task status through the unified terminal transition so a
        // completed report lands Task.status and its Kanban column in one
        // write (parity with Web AgentTools.reportToParent).
        if let Some(task_id) = &report.task_id {
            if let Some(mut task) = self.task_store.get(task_id).await? {
                let next_status = if report.success {
                    TaskStatus::Completed
                } else {
                    TaskStatus::NeedsFix
                };
                task.completion_summary = Some(report.summary.clone());
                let board = load_task_board(&self.kanban_store, &task).await;
                apply_task_status_transition(&mut task, next_status, board.as_ref());
                self.task_store.save(&task).await?;
            }
        }

        // Mark agent completed
        self.agent_store
            .update_status(child_agent_id, &AgentStatus::Completed)
            .await?;

        // Handle completion (check groups or wake parent)
        self.handle_child_completion(child_agent_id, &record)
            .await?;

        Ok(())
    }

    /// Handle child agent completion: check groups or immediately wake parent.
    async fn handle_child_completion(
        &self,
        child_agent_id: &str,
        record: &ChildAgentRecord,
    ) -> Result<(), ServerError> {
        let mut inner = self.inner.write().await;

        // Check if this child is part of an after_all group
        let mut group_complete = None;
        for (group_id, group) in inner.delegation_groups.iter_mut() {
            if group.child_agent_ids.contains(&child_agent_id.to_string()) {
                group.completed_agent_ids.insert(child_agent_id.to_string());
                tracing::info!(
                    "[Orchestrator] Agent {} completed in group {} ({}/{})",
                    child_agent_id,
                    group_id,
                    group.completed_agent_ids.len(),
                    group.child_agent_ids.len()
                );

                if group.completed_agent_ids.len() >= group.child_agent_ids.len() {
                    group_complete = Some((
                        group_id.clone(),
                        group.parent_agent_id.clone(),
                        group.parent_session_id.clone(),
                    ));
                }
                break;
            }
        }

        if let Some((group_id, parent_agent_id, parent_session_id)) = group_complete {
            tracing::info!(
                "[Orchestrator] All agents in group {} completed, waking parent",
                group_id
            );
            inner.delegation_groups.remove(&group_id);
            inner.active_group_by_agent.remove(&parent_agent_id);

            // Wake parent with group completion message
            drop(inner); // Release lock before async call
            self.wake_parent_with_group_completion(&parent_session_id, &group_id)
                .await?;
        } else {
            // Immediate mode: wake parent right away
            tracing::info!(
                "[Orchestrator] Child agent {} completed, waking parent {}",
                child_agent_id,
                record.parent_agent_id
            );
            drop(inner);
            self.wake_parent(&record.parent_session_id, child_agent_id, &record.task_id)
                .await?;
        }

        Ok(())
    }

    /// Wake a parent agent by sending a completion prompt to its session.
    async fn wake_parent(
        &self,
        parent_session_id: &str,
        child_agent_id: &str,
        task_id: &str,
    ) -> Result<(), ServerError> {
        let agent = self.agent_store.get(child_agent_id).await?;
        let task = self.task_store.get(task_id).await?;

        let wake_message = format!(
            "## Agent Completion Report\n\n\
             **Agent:** {} ({})\n\
             **Task:** {}\n\
             **Status:** {:?}\n\
             {}\n\
             Review the results and decide next steps.",
            agent
                .as_ref()
                .map(|a| a.name.as_str())
                .unwrap_or(child_agent_id),
            child_agent_id,
            task.as_ref().map(|t| t.title.as_str()).unwrap_or(task_id),
            task.as_ref().map(|t| &t.status),
            task.as_ref()
                .and_then(|t| t.completion_summary.as_ref())
                .map(|s| format!("**Summary:** {s}\n"))
                .unwrap_or_default()
        );

        if let Err(e) = self
            .acp_manager
            .prompt(parent_session_id, &wake_message)
            .await
        {
            tracing::error!(
                "[Orchestrator] Failed to wake parent session {}: {}",
                parent_session_id,
                e
            );
        }

        Ok(())
    }

    /// Wake parent with group completion message.
    async fn wake_parent_with_group_completion(
        &self,
        parent_session_id: &str,
        _group_id: &str,
    ) -> Result<(), ServerError> {
        let wake_message = "## Delegation Group Complete\n\n\
            All delegated agents have completed their work.\n\
            Review the results and decide next steps.\n\
            You may want to delegate a GATE (verifier) agent to validate the work.";

        if let Err(e) = self
            .acp_manager
            .prompt(parent_session_id, wake_message)
            .await
        {
            tracing::error!(
                "[Orchestrator] Failed to wake parent session {}: {}",
                parent_session_id,
                e
            );
        }

        Ok(())
    }

    /// Resolve specialist config from a string (role name or specialist ID).
    fn resolve_specialist(&self, input: &str) -> Option<SpecialistConfig> {
        SpecialistConfig::resolve(input)
    }

    /// Clean up resources for a session.
    pub async fn cleanup(&self, session_id: &str) {
        let mut inner = self.inner.write().await;
        let agents_to_remove: Vec<String> = inner
            .child_agents
            .iter()
            .filter(|(_, r)| r.parent_session_id == session_id || r.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();

        for agent_id in agents_to_remove {
            if let Some(record) = inner.child_agents.remove(&agent_id) {
                self.acp_manager.kill_session(&record.session_id).await;
            }
            inner.agent_session_map.remove(&agent_id);
        }
    }
}

// ─── Helper Functions ─────────────────────────────────────────────────────

/// Build the initial prompt for a delegated agent.
#[allow(clippy::too_many_arguments)]
fn build_delegation_prompt(
    specialist: &SpecialistConfig,
    agent_id: &str,
    task_id: &str,
    task_title: &str,
    task_objective: &str,
    task_scope: Option<&str>,
    acceptance_criteria: Option<&Vec<String>>,
    verification_commands: Option<&Vec<String>>,
    test_cases: Option<&Vec<String>>,
    parent_agent_id: &str,
    additional_context: Option<&str>,
) -> String {
    let mut prompt = format!(
        "{}\n\n---\n\n",
        specialist
            .system_prompt_body()
            .unwrap_or_else(|| specialist.system_prompt.clone())
    );
    prompt.push_str(&format!("**Your Agent ID:** {agent_id}\n"));
    prompt.push_str(&format!("**Your Parent Agent ID:** {parent_agent_id}\n"));
    prompt.push_str(&format!("**Task ID:** {task_id}\n\n"));
    prompt.push_str(&format!("# Task: {task_title}\n\n"));
    prompt.push_str(&format!("## Objective\n{task_objective}\n"));

    if let Some(scope) = task_scope {
        prompt.push_str(&format!("\n## Scope\n{scope}\n"));
    }

    if let Some(criteria) = acceptance_criteria {
        prompt.push_str("\n## Definition of Done\n");
        for c in criteria {
            prompt.push_str(&format!("- {c}\n"));
        }
    }

    if let Some(commands) = verification_commands {
        prompt.push_str("\n## Verification\n");
        for c in commands {
            prompt.push_str(&format!("- `{c}`\n"));
        }
    }

    if let Some(cases) = test_cases {
        prompt.push_str("\n## Test Cases\n");
        for case in cases {
            prompt.push_str(&format!("- {case}\n"));
        }
    }

    prompt.push_str(&format!(
        "\n---\n**Reminder:** {}\n",
        specialist.role_reminder
    ));

    if let Some(ctx) = additional_context {
        prompt.push_str(&format!("\n**Additional Context:** {ctx}\n"));
    }

    prompt.push_str("\n**SCOPE: Complete THIS task only.** When done, call `report_to_parent` with your results.");

    prompt
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;
