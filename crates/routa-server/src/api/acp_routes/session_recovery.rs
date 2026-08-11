//! Session recovery helpers for the ACP HTTP adapter.
//!
//! Extracted from `acp_routes.rs` to keep the route focused on request
//! dispatch: ROUTA coordinator registration/restoration and best-effort
//! provider session ID persistence live here. The durable `routa_agent_id`
//! is never replaced by a provider session ID by any of these helpers.

use std::sync::Arc;

use routa_core::models::agent::{Agent, AgentRole};
use routa_core::orchestration::{OrchestratorConfig, RoutaOrchestrator};
use routa_core::store::acp_session_store::AcpSessionRow;

use crate::state::AppState;

const RECOVERY_CONTEXT_SCHEMA: &str = "routa.recovery-envelope@1";
const MAX_HISTORY_ENTRIES: usize = 12;
const MAX_TASKS: usize = 40;
const MAX_MEMBERS: usize = 24;
const MAX_TEXT_CHARS: usize = 400;

fn bounded_text(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= MAX_TEXT_CHARS {
        return normalized;
    }
    normalized
        .chars()
        .take(MAX_TEXT_CHARS.saturating_sub(1))
        .collect::<String>()
        + "…"
}

fn history_line(value: &serde_json::Value) -> Option<String> {
    let update = value.get("update").unwrap_or(value);
    let kind = update.get("sessionUpdate")?.as_str()?;
    let role = match kind {
        "user_message" => "user",
        "agent_message" | "agent_message_chunk" => "assistant",
        _ => return None,
    };
    let text = update
        .get("content")
        .and_then(|content| {
            content
                .get("text")
                .and_then(|text| text.as_str())
                .or_else(|| content.as_str())
        })
        .or_else(|| update.get("text").and_then(|text| text.as_str()))?;
    Some(format!("- {role}: {}", bounded_text(text)))
}

fn render_recovery_context(
    session: &AcpSessionRow,
    task_lines: &[String],
    member_lines: &[String],
) -> String {
    let history = session
        .message_history
        .iter()
        .filter_map(history_line)
        .collect::<Vec<_>>();
    let history_start = history.len().saturating_sub(MAX_HISTORY_ENTRIES);
    let mut lines = vec![
        format!("<routa-internal-recovery-context schema=\"{RECOVERY_CONTEXT_SCHEMA}\">"),
        "INTERNAL RECOVERY CONTEXT injected by Routa after rebuilding the provider runtime.".to_string(),
        "This is NOT a user message. Continue the existing task; do not answer this block directly.".to_string(),
        String::new(),
        "## Session".to_string(),
        format!("- Routa session ID: {}", session.id),
        format!("- Workspace: {}", session.workspace_id),
        format!("- Working directory: {}", session.cwd),
        format!(
            "- Provider / role: {} / {}",
            session.provider.as_deref().unwrap_or("unknown"),
            session.role.as_deref().unwrap_or("unknown")
        ),
    ];
    if !task_lines.is_empty() {
        lines.push(String::new());
        lines.push("## Team Tasks".to_string());
        lines.extend(task_lines.iter().take(MAX_TASKS).cloned());
    }
    if !member_lines.is_empty() {
        lines.push(String::new());
        lines.push("## Team Members".to_string());
        lines.extend(member_lines.iter().take(MAX_MEMBERS).cloned());
    }
    if history_start < history.len() {
        lines.push(String::new());
        lines.push("## Recent Timeline".to_string());
        lines.extend(history[history_start..].iter().cloned());
    }
    lines.push("</routa-internal-recovery-context>".to_string());
    lines.join("\n")
}

pub(super) async fn build_desktop_recovery_context(
    state: &AppState,
    session: &AcpSessionRow,
) -> String {
    let is_team_lead = session.role.as_deref() == Some("ROUTA");
    let task_lines = if is_team_lead {
        state
            .task_store
            .list_by_workspace(&session.workspace_id)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|task| {
                format!(
                    "- [{}] {} ({}){}",
                    task.status.as_str(),
                    bounded_text(&task.title),
                    task.id,
                    task.assigned_to
                        .map(|agent_id| format!(" assigned to {agent_id}"))
                        .unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let member_lines = if is_team_lead {
        state
            .agent_store
            .list_by_workspace(&session.workspace_id)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|agent| {
                format!(
                    "- {} ({}, {})",
                    agent.id,
                    agent.role.as_str(),
                    agent.status.as_str()
                )
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    render_recovery_context(session, &task_lines, &member_lines)
}

pub(super) async fn ensure_routa_agent_registration(
    state: &AppState,
    session_id: &str,
    workspace_id: &str,
    role: Option<&str>,
    specialist_id: Option<&str>,
    existing_routa_agent_id: Option<&str>,
) -> Result<Option<String>, String> {
    if role != Some("ROUTA") {
        return Ok(existing_routa_agent_id.map(|value| value.to_string()));
    }

    if workspace_id == "default" {
        state
            .workspace_store
            .ensure_default()
            .await
            .map_err(|error| error.to_string())?;
    }

    let mut routa_agent_id = existing_routa_agent_id.map(|value| value.to_string());

    if let Some(existing_id) = routa_agent_id.as_deref() {
        let existing_agent = state
            .agent_store
            .get(existing_id)
            .await
            .map_err(|error| error.to_string())?;
        if existing_agent.is_none() {
            routa_agent_id = None;
        }
    }

    if routa_agent_id.is_none() {
        let name_prefix = if specialist_id == Some("team-agent-lead") {
            "team-lead"
        } else {
            "routa-coordinator"
        };
        let agent = Agent::new(
            uuid::Uuid::new_v4().to_string(),
            format!("{}-{}", name_prefix, &session_id[..session_id.len().min(8)]),
            AgentRole::Routa,
            workspace_id.to_string(),
            None,
            None,
            None,
        );
        state
            .agent_store
            .save(&agent)
            .await
            .map_err(|error| error.to_string())?;
        routa_agent_id = Some(agent.id);
    }

    let acp = Arc::new(state.acp_manager.clone());
    let orchestrator = RoutaOrchestrator::new(
        OrchestratorConfig::default(),
        acp,
        state.agent_store.clone(),
        state.task_store.clone(),
        state.event_bus.clone(),
    );
    let routa_agent_id = routa_agent_id.expect("routa agent id must exist for ROUTA session");
    orchestrator
        .register_agent_session(&routa_agent_id, session_id)
        .await;
    let _ = state
        .acp_manager
        .set_routa_agent_id(session_id, &routa_agent_id)
        .await;
    state
        .acp_session_store
        .set_routa_agent_id(session_id, Some(&routa_agent_id))
        .await
        .map_err(|error| error.to_string())?;

    Ok(Some(routa_agent_id))
}

/// Persist a captured provider session ID; failures are logged, not fatal.
pub(super) async fn persist_provider_session_id(
    state: &AppState,
    session_id: &str,
    provider_session_id: &str,
) {
    if let Err(e) = state
        .acp_session_store
        .set_provider_session_id(session_id, Some(provider_session_id))
        .await
    {
        tracing::warn!(
            "[ACP Route] Failed to persist provider session id for {}: {}",
            session_id,
            e
        );
    }
}

/// Restore the durable Routa logical agent binding during recovery. The
/// provider session ID must NEVER be written to `routa_agent_id`;
/// `ensure_routa_agent_registration` reuses the persisted `routa_agent_id`
/// when it is still valid and re-registers the agent↔session mapping so team
/// orchestration survives recovery.
///
/// All-or-nothing (P1 parity with the Web backend): a restoration FAILURE is
/// propagated to the caller instead of being swallowed. Recovery must never
/// report success for a ROUTA session whose coordination bindings could not
/// be restored — that is exactly the silent chat-only degradation the Web
/// `restoreTeamRuntimeBindings` contract forbids.
pub(super) async fn restore_routa_coordinator_binding(
    state: &AppState,
    session_id: &str,
    workspace_id: &str,
    role: Option<&str>,
    persisted_routa_agent_id: Option<&str>,
) -> Result<Option<String>, String> {
    ensure_routa_agent_registration(
        state,
        session_id,
        workspace_id,
        role,
        None,
        persisted_routa_agent_id,
    )
    .await
}

/// Structured JSON-RPC error for a ROUTA recovery whose team/coordinator
/// bindings could not be restored. Mirrors the Web contract:
/// code `-32012`, `data.reason = "recovery_failed"`,
/// `data.failure = "team_bindings_incomplete"`, `retryable = true`.
/// Human-readable text may differ between backends; clients branch on the
/// structured fields.
pub(super) fn team_bindings_failed_response(
    id: &serde_json::Value,
    session_id: &str,
    error: &str,
) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32012,
            "message": format!(
                "Failed to restore team runtime bindings for {}: {}. \
                 No chat-only runtime was started; the session keeps its history and input.",
                session_id, error
            ),
            "data": {
                "reason": "recovery_failed",
                "retryable": true,
                "failure": "team_bindings_incomplete",
                "sessionId": session_id
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn persisted_session_with_history(history: Vec<serde_json::Value>) -> AcpSessionRow {
        AcpSessionRow {
            id: "session-1".to_string(),
            name: Some("Lead".to_string()),
            cwd: "/workspace".to_string(),
            branch: Some("main".to_string()),
            workspace_id: "workspace-1".to_string(),
            routa_agent_id: Some("agent-lead".to_string()),
            provider_session_id: None,
            provider: Some("claude".to_string()),
            role: Some("ROUTA".to_string()),
            mode_id: None,
            custom_command: None,
            custom_args: Vec::new(),
            first_prompt_sent: true,
            message_history: history,
            created_at: 1,
            updated_at: 1,
            parent_session_id: None,
            team_chain_id: None,
        }
    }

    /// Web/Rust contract parity: a ROUTA session whose team/coordinator
    /// bindings cannot be restored during recovery reports the SAME
    /// structured JSON-RPC error as the Web backend. Recovery never silently
    /// returns success for a chat-only runtime.
    #[test]
    fn team_bindings_failure_matches_web_recovery_contract() {
        let value =
            team_bindings_failed_response(&serde_json::json!(7), "session-1", "store offline");

        assert_eq!(value["jsonrpc"].as_str(), Some("2.0"));
        assert_eq!(value["id"].as_i64(), Some(7));
        assert_eq!(value["error"]["code"].as_i64(), Some(-32012));
        assert_eq!(
            value["error"]["data"]["reason"].as_str(),
            Some("recovery_failed"),
        );
        assert_eq!(value["error"]["data"]["retryable"].as_bool(), Some(true));
        assert_eq!(
            value["error"]["data"]["failure"].as_str(),
            Some("team_bindings_incomplete"),
        );
        assert_eq!(
            value["error"]["data"]["sessionId"].as_str(),
            Some("session-1"),
        );
        // The message must name the session and the cause.
        let message = value["error"]["message"].as_str().unwrap_or("");
        assert!(message.contains("session-1"));
        assert!(message.contains("store offline"));
    }

    #[test]
    fn context_rebuild_uses_bounded_internal_envelope() {
        let history = (0..20)
            .map(|index| {
                serde_json::json!({
                    "update": {
                        "sessionUpdate": if index % 2 == 0 { "user_message" } else { "agent_message" },
                        "content": { "type": "text", "text": format!("message-{index}") }
                    }
                })
            })
            .collect();
        let session = persisted_session_with_history(history);

        let context = render_recovery_context(
            &session,
            &["- [IN_PROGRESS] Implement recovery (task-1)".to_string()],
            &["- agent-child (CRAFTER, ACTIVE)".to_string()],
        );

        assert!(context.contains("routa.recovery-envelope@1"));
        assert!(context.contains("This is NOT a user message"));
        assert!(context.contains("## Team Tasks"));
        assert!(context.contains("## Team Members"));
        assert!(!context.contains("message-0"));
        assert!(context.contains("message-19"));
        assert_eq!(
            context.matches("- user:").count() + context.matches("- assistant:").count(),
            12
        );
    }
}
