use super::{
    get_preset_by_id_with_registry, get_presets, truncate_content, validate_session_cwd,
    AcpManager, AcpSessionRecord,
};
use std::collections::HashMap;
use std::fs;
use std::sync::Arc;
use tokio::sync::RwLock;

#[test]
fn static_presets_include_codex_acp_for_codex_alias() {
    assert!(get_presets().iter().any(|preset| preset.id == "codex-acp"));
}

#[test]
fn static_presets_include_qoder() {
    let qoder = get_presets()
        .into_iter()
        .find(|preset| preset.id == "qoder")
        .expect("qoder preset");
    assert_eq!(
        qoder.args,
        vec!["--acp".to_string(), "--experimental-mcp-load".to_string()]
    );
}

#[tokio::test]
async fn qodercli_alias_resolves_to_qoder_preset() {
    let preset = get_preset_by_id_with_registry("qodercli")
        .await
        .expect("qodercli alias should resolve");
    assert_eq!(preset.id, "qodercli");
    assert_eq!(preset.command, "qodercli");
    assert_eq!(
        preset.args,
        vec!["--acp".to_string(), "--experimental-mcp-load".to_string()]
    );
}

#[test]
fn validate_session_cwd_rejects_missing_or_non_directory_paths() {
    let temp = tempfile::tempdir().expect("tempdir should create");
    let missing = temp.path().join("missing-dir");
    let file_path = temp.path().join("not-a-dir.txt");
    fs::write(&file_path, "content").expect("file should write");

    assert!(validate_session_cwd(missing.to_string_lossy().as_ref())
        .expect_err("missing directory should fail")
        .contains("directory does not exist"));
    assert!(validate_session_cwd(file_path.to_string_lossy().as_ref())
        .expect_err("file path should fail")
        .contains("path is not a directory"));
    validate_session_cwd(temp.path().to_string_lossy().as_ref())
        .expect("existing directory should pass");
}

#[tokio::test]
async fn mark_first_prompt_sent_updates_live_session_record() {
    let manager = AcpManager::new();
    let session_id = "session-1".to_string();
    manager.sessions.write().await.insert(
        session_id.clone(),
        AcpSessionRecord {
            session_id: session_id.clone(),
            name: None,
            cwd: ".".to_string(),
            workspace_id: "default".to_string(),
            routa_agent_id: None,
            provider: Some("opencode".to_string()),
            role: Some("CRAFTER".to_string()),
            mode_id: None,
            model: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            first_prompt_sent: false,
            parent_session_id: None,
            specialist_id: None,
            team_chain_id: None,
            specialist_system_prompt: None,
        },
    );
    manager.mark_first_prompt_sent(&session_id).await;
    assert!(
        manager
            .get_session(&session_id)
            .await
            .expect("session")
            .first_prompt_sent
    );
}

#[tokio::test]
async fn push_to_history_skips_parent_child_forwarding_noise() {
    let manager = AcpManager::new();
    manager
        .push_to_history(
            "parent",
            serde_json::json!({
                "sessionId": "parent",
                "childAgentId": "child-1",
                "update": { "sessionUpdate": "agent_message", "content": { "type": "text", "text": "delegated" } }
            }),
        )
        .await;
    assert!(manager
        .get_session_history("parent")
        .await
        .unwrap_or_default()
        .is_empty());
}

#[tokio::test]
async fn emit_session_update_broadcasts_when_channel_exists() {
    let (tx, mut rx) = tokio::sync::broadcast::channel(8);
    let manager = AcpManager {
        notification_channels: Arc::new(RwLock::new(HashMap::from([(
            "session-1".to_string(),
            tx,
        )]))),
        ..AcpManager::new()
    };
    manager
        .emit_session_update(
            "session-1",
            serde_json::json!({ "sessionUpdate": "turn_complete", "stopReason": "cancelled" }),
        )
        .await
        .expect("emit should succeed");
    let broadcast = rx.recv().await.expect("broadcast event");
    assert_eq!(
        broadcast["params"]["update"]["sessionUpdate"].as_str(),
        Some("turn_complete")
    );
    assert_eq!(
        broadcast["params"]["update"]["stopReason"].as_str(),
        Some("cancelled")
    );
}

#[tokio::test]
async fn emit_session_update_persists_history_without_channel() {
    let manager = AcpManager::new();
    manager
        .emit_session_update(
            "session-1",
            serde_json::json!({ "sessionUpdate": "turn_complete", "stopReason": "cancelled" }),
        )
        .await
        .expect("emit should succeed");
    let history = manager
        .get_session_history("session-1")
        .await
        .expect("history should exist");
    assert_eq!(history.len(), 1);
    assert_eq!(
        history[0]["update"]["sessionUpdate"].as_str(),
        Some("turn_complete")
    );
}

#[test]
fn rewrite_notification_session_id_overrides_provider_session_id() {
    let rewritten = AcpManager::rewrite_notification_session_id(
        "child-session",
        serde_json::json!({
            "sessionId": "provider-session",
            "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "hi" } }
        }),
    );
    assert_eq!(rewritten["sessionId"].as_str(), Some("child-session"));
}

#[test]
fn truncate_content_handles_unicode_boundaries() {
    assert_eq!(truncate_content("你好世界ABC", 5), "你好...");
    assert_eq!(truncate_content("你好世界ABC", 3), "你好世");
    assert_eq!(truncate_content("短文本", 10), "短文本");
}
