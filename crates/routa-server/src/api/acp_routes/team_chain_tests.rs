use std::sync::Arc;

use axum::{extract::State, Json};
use routa_core::{db::Database, state::AppStateInner};
use serde_json::json;

use super::{acp_rpc, AcpResponse};

fn json_response_value(response: AcpResponse) -> serde_json::Value {
    match response {
        AcpResponse::Json(Json(value)) => value,
        AcpResponse::Sse(_) => panic!("expected JSON response"),
    }
}

async fn team_chain_session_new(params: serde_json::Value) -> serde_json::Value {
    let db = Database::open_in_memory().expect("db should open");
    let state = Arc::new(AppStateInner::new(db));
    state
        .workspace_store
        .ensure_default()
        .await
        .expect("default workspace should exist");

    let response = acp_rpc(
        State(state),
        Json(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "session/new",
            "params": params
        })),
    )
    .await
    .expect("request should complete");

    json_response_value(response)
}

#[tokio::test]
async fn session_new_rejects_unknown_team_chain_id() {
    let value = team_chain_session_new(json!({
        "workspaceId": "default",
        "cwd": "/tmp",
        "provider": "opencode",
        "specialistId": "team-agent-lead",
        "teamChainId": "bogus"
    }))
    .await;

    assert_eq!(value["error"]["code"].as_i64(), Some(-32602));
    assert_eq!(
        value["error"]["message"].as_str(),
        Some("teamChainId must be one of: lightweight, standard_delivery, full_delivery")
    );
}

#[tokio::test]
async fn session_new_rejects_non_string_team_chain_id() {
    let value = team_chain_session_new(json!({
        "workspaceId": "default",
        "cwd": "/tmp",
        "provider": "opencode",
        "specialistId": "team-agent-lead",
        "teamChainId": 123
    }))
    .await;

    assert_eq!(value["error"]["code"].as_i64(), Some(-32602));
    assert_eq!(
        value["error"]["message"].as_str(),
        Some("teamChainId must be one of: lightweight, standard_delivery, full_delivery")
    );
}

#[tokio::test]
async fn session_new_rejects_team_chain_id_on_non_team_lead() {
    let value = team_chain_session_new(json!({
        "workspaceId": "default",
        "cwd": "/tmp",
        "provider": "opencode",
        "specialistId": "researcher",
        "teamChainId": "lightweight"
    }))
    .await;

    assert_eq!(value["error"]["code"].as_i64(), Some(-32602));
    assert_eq!(
        value["error"]["message"].as_str(),
        Some("teamChainId is only allowed on team-agent-lead sessions")
    );
}

#[tokio::test]
async fn session_new_rejects_team_chain_id_on_child_session() {
    let value = team_chain_session_new(json!({
        "workspaceId": "default",
        "cwd": "/tmp",
        "provider": "opencode",
        "specialistId": "team-agent-lead",
        "parentSessionId": "parent-1",
        "teamChainId": "lightweight"
    }))
    .await;

    assert_eq!(value["error"]["code"].as_i64(), Some(-32602));
    assert_eq!(
        value["error"]["message"].as_str(),
        Some("teamChainId is only allowed on top-level team sessions")
    );
}
