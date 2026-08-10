use super::{AcpManager, AgentProcessType};

impl AcpManager {
    /// A parent or child still has a live runtime, so this session must not be
    /// automatically released yet.
    pub async fn has_active_session_dependency(&self, session_id: &str) -> bool {
        let sessions = self.sessions.read().await;
        let processes = self.processes.read().await;
        let is_alive = |candidate: &str| {
            processes
                .get(candidate)
                .is_some_and(|managed| match &managed.process {
                    AgentProcessType::Acp(process) => process.is_alive(),
                    AgentProcessType::Claude(process) => process.is_alive(),
                })
        };

        sessions
            .get(session_id)
            .and_then(|session| session.parent_session_id.as_deref())
            .is_some_and(is_alive)
            || sessions.values().any(|session| {
                session.parent_session_id.as_deref() == Some(session_id)
                    && is_alive(&session.session_id)
            })
    }

    /// Return completed Claude sessions that are not protected by a live
    /// parent/child dependency. Their durable history remains in SQLite.
    pub async fn collect_completed_session_ids(&self) -> Vec<String> {
        let completed = self.completed_sessions.read().await.clone();
        let mut result = Vec::new();
        for session_id in completed {
            if !self.has_active_session_dependency(&session_id).await {
                result.push(session_id);
            }
        }
        result
    }

    pub(super) async fn record_completed_claude_turn(&self, session_id: &str, stop_reason: String) {
        self.completed_sessions
            .write()
            .await
            .insert(session_id.to_string());
        let _ = self
            .emit_session_update(
                session_id,
                serde_json::json!({
                    "sessionUpdate": "turn_complete",
                    "stopReason": stop_reason,
                }),
            )
            .await;
    }
}
