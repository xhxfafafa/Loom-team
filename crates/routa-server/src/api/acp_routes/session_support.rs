use crate::state::AppState;

pub(super) fn has_explicit_cwd(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .map(|cwd| !cwd.is_empty() && cwd != ".")
        .unwrap_or(false)
}

pub(super) async fn resolve_session_cwd(
    state: &AppState,
    workspace_id: &str,
    requested_cwd: Option<&str>,
) -> String {
    if let Some(cwd) = requested_cwd.filter(|value| has_explicit_cwd(Some(value))) {
        return cwd.trim().to_string();
    }
    if let Ok(Some(codebase)) = state.codebase_store.get_default(workspace_id).await {
        if !codebase.repo_path.trim().is_empty() {
            return codebase.repo_path;
        }
    }
    if let Ok(codebases) = state.codebase_store.list_by_workspace(workspace_id).await {
        if let Some(codebase) = codebases
            .into_iter()
            .find(|codebase| !codebase.repo_path.trim().is_empty())
        {
            return codebase.repo_path;
        }
    }
    std::env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

pub(super) fn is_confirmed_normal_completion(message: &serde_json::Value) -> bool {
    let update = message
        .get("params")
        .and_then(|params| params.get("update"));
    update
        .and_then(|value| value.get("sessionUpdate"))
        .and_then(|value| value.as_str())
        == Some("turn_complete")
        && matches!(
            update
                .and_then(|value| value.get("stopReason"))
                .and_then(|value| value.as_str()),
            Some("end_turn") | Some("stop_sequence")
        )
}

pub(super) async fn maybe_release_completed_session(
    state: &AppState,
    session_id: &str,
    confirmed_normal_completion: bool,
) {
    let enabled = std::env::var("ROUTA_AUTO_RELEASE_COMPLETED_CLAUDE")
        .map(|value| value != "0" && !value.eq_ignore_ascii_case("false"))
        .unwrap_or(true);
    if confirmed_normal_completion
        && enabled
        && !state
            .acp_manager
            .has_active_session_dependency(session_id)
            .await
    {
        state.acp_manager.kill_session(session_id).await;
    }
}
