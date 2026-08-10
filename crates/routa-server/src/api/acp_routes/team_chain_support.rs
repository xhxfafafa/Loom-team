//! Team execution-chain helpers for the ACP HTTP adapter.
//!
//! This keeps request-shape validation and prompt composition out of the
//! behavior-heavy ACP route while preserving the shared core policy rules.

use axum::Json;
use routa_core::orchestration::{
    build_team_chain_policy_prompt, validate_team_chain_assignment, SpecialistConfig,
    TeamChainValidationError,
};
use serde_json::Value;

use routa_core::acp::SessionLaunchOptions;

use super::AcpResponse;

/// Validate the raw JSON-RPC `teamChainId` field.
///
/// `null` is equivalent to omission for backwards compatibility. Any other
/// non-string JSON value is an invalid parameter rather than an omitted one;
/// this mirrors the TypeScript backend's `unknown` validation.
pub(super) fn validate_team_chain_request(
    params: &Value,
    specialist_id: Option<&str>,
    parent_session_id: Option<&str>,
) -> Result<Option<String>, TeamChainValidationError> {
    match params.get("teamChainId") {
        None | Some(Value::Null) => {
            validate_team_chain_assignment(None, specialist_id, parent_session_id)
        }
        Some(Value::String(value)) => {
            validate_team_chain_assignment(Some(value), specialist_id, parent_session_id)
        }
        Some(_) => Err(TeamChainValidationError::InvalidValue),
    }
}

pub(super) fn resolve_team_chain_request(
    params: &Value,
    id: &Value,
    specialist_id: Option<&str>,
    parent_session_id: Option<&str>,
) -> Result<Option<String>, AcpResponse> {
    validate_team_chain_request(params, specialist_id, parent_session_id).map_err(|reason| {
        AcpResponse::Json(Json(serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32602, "message": reason.message() }
        })))
    })
}

/// Append a non-default Team Chain policy to the resolved specialist prompt.
/// Full Delivery and legacy sessions intentionally retain their original
/// specialist prompt without an additional policy section.
pub(super) fn compose_team_chain_specialist_prompt(
    base_specialist_prompt: Option<String>,
    team_chain_id: Option<&str>,
) -> Option<String> {
    match (
        base_specialist_prompt,
        build_team_chain_policy_prompt(team_chain_id),
    ) {
        (Some(base), Some(policy)) => Some(format!("{base}\n\n---\n\n{policy}")),
        (Some(base), None) => Some(base),
        (None, Some(policy)) => Some(policy.to_string()),
        (None, None) => None,
    }
}

pub(super) fn build_team_chain_launch_options(
    params: &Value,
    specialist: Option<&SpecialistConfig>,
    specialist_id: Option<String>,
    team_chain_id: Option<String>,
) -> SessionLaunchOptions {
    let base_specialist_prompt = params
        .get("systemPrompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
        .map(str::to_string)
        .or_else(|| specialist.and_then(SpecialistConfig::system_prompt_with_reminder));

    let allowed_native_tools = (specialist_id.as_deref() == Some("team-agent-lead")).then(Vec::new);
    SessionLaunchOptions {
        specialist_id,
        specialist_system_prompt: compose_team_chain_specialist_prompt(
            base_specialist_prompt,
            team_chain_id.as_deref(),
        ),
        team_chain_id,
        allowed_native_tools,
        ..SessionLaunchOptions::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_string_chain_value_is_rejected_instead_of_treated_as_omitted() {
        let params = serde_json::json!({ "teamChainId": 123 });

        assert_eq!(
            validate_team_chain_request(&params, Some("team-agent-lead"), None,),
            Err(TeamChainValidationError::InvalidValue),
        );
    }

    #[test]
    fn null_chain_value_remains_compatible_with_legacy_sessions() {
        let params = serde_json::json!({ "teamChainId": null });

        assert_eq!(validate_team_chain_request(&params, None, None), Ok(None),);
    }

    #[test]
    fn policy_is_only_appended_for_non_default_chains() {
        let lightweight = compose_team_chain_specialist_prompt(
            Some("base prompt".to_string()),
            Some("lightweight"),
        )
        .expect("lightweight prompt");
        assert!(lightweight.contains("Team Chain Policy: Lightweight"));

        assert_eq!(
            compose_team_chain_specialist_prompt(
                Some("base prompt".to_string()),
                Some("full_delivery"),
            ),
            Some("base prompt".to_string()),
        );
    }
}
