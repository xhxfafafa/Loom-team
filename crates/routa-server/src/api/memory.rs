use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use sysinfo::System;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/",
        get(get_memory_stats)
            .post(cleanup_memory)
            .delete(reset_memory),
    )
}

pub fn legacy_router() -> Router<AppState> {
    Router::new().route(
        "/",
        get(get_legacy_memory_stats)
            .post(cleanup_legacy_memory)
            .delete(reset_legacy_memory),
    )
}

#[derive(Debug, Deserialize)]
struct MemoryQuery {
    history: Option<bool>,
}

/// GET /api/system/memory — Get memory usage statistics.
///
/// For desktop version, returns system memory info.
async fn get_memory_stats(
    State(_state): State<AppState>,
    Query(query): Query<MemoryQuery>,
) -> Json<serde_json::Value> {
    let mut sys = System::new_all();
    sys.refresh_memory();

    let total_memory = sys.total_memory();
    let used_memory = sys.used_memory();
    let available_memory = sys.available_memory();

    let usage_percentage = if total_memory > 0 {
        (used_memory as f64 / total_memory as f64 * 100.0) as u64
    } else {
        0
    };

    let level = if usage_percentage > 90 {
        "critical"
    } else if usage_percentage > 75 {
        "warning"
    } else {
        "normal"
    };

    let stats = serde_json::json!({
        "heapUsedMB": used_memory / 1024 / 1024,
        "heapTotalMB": total_memory / 1024 / 1024,
        "availableMB": available_memory / 1024 / 1024,
        "usagePercentage": usage_percentage,
        "level": level,
        "timestamp": chrono::Utc::now().to_rfc3339(),
    });

    if query.history.unwrap_or(false) {
        // Return with history; field names must match the Next.js API
        // so the frontend can parse the response uniformly.
        Json(serde_json::json!({
            "current": stats,
            "peaks": {
                "heapUsedMB": stats["heapUsedMB"],
                "rssMB": 0,
            },
            "growthRateMBPerMinute": 0,
            "snapshots": [],
            "sessionStore": {
                "sessionCount": 0,
                "totalHistoryMessages": 0,
                "staleSessionCount": 0,
                "activeSseCount": 0,
            },
        }))
    } else {
        Json(serde_json::json!({ "current": stats }))
    }
}

/// GET /api/memory — Deprecated alias for /api/system/memory.
async fn get_legacy_memory_stats(
    state: State<AppState>,
    query: Query<MemoryQuery>,
) -> impl IntoResponse {
    (legacy_headers(), get_memory_stats(state, query).await)
}

/// POST /api/system/memory — Release completed desktop agent runtimes.
///
/// Only provider-confirmed completed sessions are eligible. Active work and
/// parent/child dependencies stay untouched; durable SQLite history is saved
/// before the process and its MCP teardown are released.
async fn cleanup_memory(State(state): State<AppState>) -> Json<serde_json::Value> {
    let session_ids = state.acp_manager.collect_completed_session_ids().await;
    let mut agent_processes_terminated = 0usize;

    for session_id in session_ids {
        if let Some(history) = state.acp_manager.get_session_history(&session_id).await {
            if !history.is_empty()
                && state
                    .acp_session_store
                    .save_history(&session_id, &history)
                    .await
                    .is_err()
            {
                continue;
            }
        }
        state.acp_manager.kill_session(&session_id).await;
        agent_processes_terminated += 1;
    }

    Json(serde_json::json!({
        "success": true,
        "message": "Released completed desktop agent runtimes",
        "cleaned": agent_processes_terminated,
        "runtime": {
            "agentProcessesTerminated": agent_processes_terminated,
            // Rust provider teardown currently owns config/transport cleanup
            // internally but does not expose a per-proxy completion signal.
            // Report zero rather than fabricate a proxy count.
            "mcpProxiesCleaned": 0,
            "failures": []
        }
    }))
}

/// POST /api/memory — Deprecated alias for /api/system/memory.
async fn cleanup_legacy_memory(state: State<AppState>) -> impl IntoResponse {
    (legacy_headers(), cleanup_memory(state).await)
}

/// DELETE /api/system/memory — Reset memory monitoring.
///
/// For desktop version, this is a no-op.
async fn reset_memory(State(_state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "success": true,
        "message": "Memory monitoring reset not needed in desktop version"
    }))
}

/// DELETE /api/memory — Deprecated alias for /api/system/memory.
async fn reset_legacy_memory(state: State<AppState>) -> impl IntoResponse {
    (legacy_headers(), reset_memory(state).await)
}

fn legacy_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("deprecation"),
        HeaderValue::from_static("true"),
    );
    headers.insert(
        header::LINK,
        HeaderValue::from_static("</api/system/memory>; rel=\"successor-version\""),
    );
    headers.insert(
        HeaderName::from_static("warning"),
        HeaderValue::from_static("299 - \"Deprecated API route; use /api/system/memory\""),
    );
    headers.insert(
        HeaderName::from_static("x-routa-deprecated-route"),
        HeaderValue::from_static("/api/memory"),
    );
    headers.insert(
        HeaderName::from_static("x-routa-replacement-route"),
        HeaderValue::from_static("/api/system/memory"),
    );
    headers
}
