use super::*;
use crate::db::Database;
use crate::models::task::Task;
use crate::models::workspace::Workspace;
use crate::store::WorkspaceStore;

async fn setup() -> (RoutaOrchestrator, TaskStore, AgentStore) {
    let db = Database::open_in_memory().expect("in-memory db should open");
    let workspace_store = WorkspaceStore::new(db.clone());
    workspace_store
        .save(&Workspace::new(
            "default".to_string(),
            "Default".to_string(),
            None,
        ))
        .await
        .expect("workspace save should succeed");
    let task_store = TaskStore::new(db.clone());
    let agent_store = AgentStore::new(db.clone());
    let kanban_store = KanbanStore::new(db);
    let orchestrator = RoutaOrchestrator::new(
        OrchestratorConfig::default(),
        Arc::new(AcpManager::new()),
        agent_store.clone(),
        task_store.clone(),
        kanban_store,
        EventBus::new(),
    );
    (orchestrator, task_store, agent_store)
}

fn make_task(task_id: &str) -> Task {
    Task::new(
        task_id.to_string(),
        "Implement feature".to_string(),
        "Build the feature".to_string(),
        "default".to_string(),
        Some("creator-session".to_string()),
        None,
        None,
        None,
        None,
        None,
        None,
    )
}

fn params(task_id: &str, specialist: &str, provider: Option<&str>) -> DelegateWithSpawnParams {
    DelegateWithSpawnParams {
        task_id: task_id.to_string(),
        caller_agent_id: "caller-agent".to_string(),
        caller_session_id: "caller-session".to_string(),
        workspace_id: "default".to_string(),
        specialist: specialist.to_string(),
        provider: provider.map(|value| value.to_string()),
        cwd: None,
        additional_instructions: None,
        wait_mode: "immediate".to_string(),
    }
}

#[tokio::test]
async fn unknown_specialist_returns_error_without_touching_stores() {
    let (orchestrator, task_store, agent_store) = setup().await;
    task_store.save(&make_task("task-1")).await.expect("save");

    let result = orchestrator
        .delegate_task_with_spawn(params("task-1", "no-such-role", None))
        .await
        .expect("delegation resolves");
    assert!(!result.success);
    assert!(result
        .error
        .unwrap_or_default()
        .contains("Unknown specialist"));

    assert!(
        agent_store
            .list_by_workspace("default")
            .await
            .expect("list agents")
            .is_empty(),
        "no agent record may be created for an unknown specialist"
    );
    let task = task_store.get("task-1").await.expect("get").expect("task");
    assert_eq!(task.status, TaskStatus::Pending);
    assert!(task.assigned_to.is_none());
}

#[tokio::test]
async fn spawn_failure_before_binding_keeps_task_unbound_and_marks_agent_error() {
    let (orchestrator, task_store, agent_store) = setup().await;
    task_store.save(&make_task("task-1")).await.expect("save");
    // No provider binary named "no-such-provider" exists: session
    // creation fails before the binding is saved.
    let result = orchestrator
        .delegate_task_with_spawn(params("task-1", "CRAFTER", Some("no-such-provider")))
        .await
        .expect("delegation resolves");
    assert!(
        !result.success,
        "delegation must fail when the child session cannot be created"
    );
    assert!(result
        .error
        .unwrap_or_default()
        .contains("Failed to spawn agent process"));

    // The binding was never persisted: the task keeps its creator session,
    // its status, and an empty session history.
    let task = task_store.get("task-1").await.expect("get").expect("task");
    assert_eq!(task.status, TaskStatus::Pending);
    assert!(task.assigned_to.is_none());
    assert!(task.session_ids.is_empty());
    assert_eq!(task.session_id.as_deref(), Some("creator-session"));

    // The fresh agent record is marked ERROR, never ACTIVE.
    let agents = agent_store
        .list_by_workspace("default")
        .await
        .expect("list");
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].status, AgentStatus::Error);
}

#[test]
fn append_delegation_session_id_dedupes() {
    assert_eq!(append_delegation_session_id(&[], "s1"), vec!["s1"]);
    assert_eq!(
        append_delegation_session_id(&["s1".to_string()], "s1"),
        vec!["s1"]
    );
    assert_eq!(
        append_delegation_session_id(&["s1".to_string(), "s2".to_string()], "s2"),
        vec!["s1", "s2"]
    );
    assert_eq!(
        append_delegation_session_id(&["s1".to_string()], "s2"),
        vec!["s1", "s2"]
    );
}

async fn seed_delegated_child(
    orchestrator: &RoutaOrchestrator,
    agent_store: &AgentStore,
    task_id: &str,
) {
    let agent = crate::models::agent::Agent::new(
        "child-agent-1".to_string(),
        "Implementor".to_string(),
        AgentRole::Crafter,
        "default".to_string(),
        Some("parent-agent".to_string()),
        None,
        None,
    );
    agent_store.save(&agent).await.expect("agent save");
    let mut inner = orchestrator.inner.write().await;
    inner.child_agents.insert(
        "child-agent-1".to_string(),
        ChildAgentRecord {
            agent_id: "child-agent-1".to_string(),
            session_id: "child-session-1".to_string(),
            parent_agent_id: "parent-agent".to_string(),
            parent_session_id: "parent-session".to_string(),
            task_id: task_id.to_string(),
            role: AgentRole::Crafter,
            provider: "opencode".to_string(),
        },
    );
}

#[tokio::test]
async fn report_submitted_success_moves_task_to_done_column() {
    let (orchestrator, task_store, agent_store) = setup().await;
    let board = orchestrator
        .kanban_store
        .ensure_default_board(&"default".to_string())
        .await
        .expect("default board should be created");
    let mut task = make_task("task-report");
    task.board_id = Some(board.id.clone());
    task.column_id = Some("dev".to_string());
    task.status = TaskStatus::InProgress;
    task_store.save(&task).await.expect("task save");
    seed_delegated_child(&orchestrator, &agent_store, "task-report").await;

    orchestrator
        .handle_report_submitted(
            "child-agent-1",
            &CompletionReport {
                agent_id: "child-agent-1".to_string(),
                task_id: Some("task-report".to_string()),
                summary: "Implemented the feature".to_string(),
                success: true,
                files_modified: None,
            },
        )
        .await
        .expect("report should be handled");

    let stored = task_store
        .get("task-report")
        .await
        .expect("task load")
        .expect("task should exist");
    assert_eq!(stored.status, TaskStatus::Completed);
    assert_eq!(stored.column_id.as_deref(), Some("done"));
    assert_eq!(
        stored.completion_summary.as_deref(),
        Some("Implemented the feature")
    );

    let agent = agent_store
        .get("child-agent-1")
        .await
        .expect("agent load")
        .expect("agent should exist");
    assert_eq!(agent.status, AgentStatus::Completed);
}

#[tokio::test]
async fn report_submitted_failure_marks_needs_fix_and_keeps_column() {
    let (orchestrator, task_store, agent_store) = setup().await;
    let board = orchestrator
        .kanban_store
        .ensure_default_board(&"default".to_string())
        .await
        .expect("default board should be created");
    let mut task = make_task("task-report-fix");
    task.board_id = Some(board.id.clone());
    task.column_id = Some("dev".to_string());
    task.status = TaskStatus::InProgress;
    task_store.save(&task).await.expect("task save");
    seed_delegated_child(&orchestrator, &agent_store, "task-report-fix").await;

    orchestrator
        .handle_report_submitted(
            "child-agent-1",
            &CompletionReport {
                agent_id: "child-agent-1".to_string(),
                task_id: Some("task-report-fix".to_string()),
                summary: "Tests still failing".to_string(),
                success: false,
                files_modified: None,
            },
        )
        .await
        .expect("report should be handled");

    let stored = task_store
        .get("task-report-fix")
        .await
        .expect("task load")
        .expect("task should exist");
    assert_eq!(stored.status, TaskStatus::NeedsFix);
    assert_eq!(
        stored.column_id.as_deref(),
        Some("dev"),
        "NEEDS_FIX must never be mapped to a column automatically"
    );
    assert_eq!(
        stored.completion_summary.as_deref(),
        Some("Tests still failing")
    );
}
