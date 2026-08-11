use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

#[derive(Clone, Default)]
pub(super) struct RecoveryContextStore {
    pending: Arc<RwLock<HashMap<String, String>>>,
}

impl RecoveryContextStore {
    pub(super) async fn set(&self, session_id: &str, context: String) {
        self.pending
            .write()
            .await
            .insert(session_id.to_string(), context);
    }

    pub(super) async fn take_for_prompt(
        &self,
        session_id: &str,
        prompt: &str,
    ) -> (String, Option<String>) {
        let context = self.pending.write().await.remove(session_id);
        let effective_prompt = context
            .as_ref()
            .map(|context| format!("{context}\n\n{prompt}"))
            .unwrap_or_else(|| prompt.to_string());
        (effective_prompt, context)
    }

    pub(super) async fn restore(&self, session_id: &str, context: Option<String>) {
        if let Some(context) = context {
            self.pending
                .write()
                .await
                .entry(session_id.to_string())
                .or_insert(context);
        }
    }

    pub(super) async fn remove(&self, session_id: &str) {
        self.pending.write().await.remove(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn context_is_consumed_once_and_restored_after_failure() {
        let store = RecoveryContextStore::default();
        store.set("session-1", "INTERNAL CONTEXT".to_string()).await;
        let (first, consumed) = store.take_for_prompt("session-1", "continue").await;
        assert!(first.starts_with("INTERNAL CONTEXT"));
        assert_eq!(store.take_for_prompt("session-1", "next").await.0, "next");

        store.restore("session-1", consumed).await;
        assert!(store
            .take_for_prompt("session-1", "retry")
            .await
            .0
            .starts_with("INTERNAL CONTEXT"));
    }
}
