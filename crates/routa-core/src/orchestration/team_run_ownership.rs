use std::collections::{HashMap, HashSet};

use crate::acp::AcpSessionRecord;

use super::TEAM_LEAD_SPECIALIST_ID;

#[derive(Debug, Clone)]
pub struct OwnershipSessionShape {
    pub session_id: String,
    pub workspace_id: String,
    pub name: Option<String>,
    pub role: Option<String>,
    pub specialist_id: Option<String>,
    pub parent_session_id: Option<String>,
}

impl From<&AcpSessionRecord> for OwnershipSessionShape {
    fn from(record: &AcpSessionRecord) -> Self {
        Self {
            session_id: record.session_id.clone(),
            workspace_id: record.workspace_id.clone(),
            name: record.name.clone(),
            role: record.role.clone(),
            specialist_id: record.specialist_id.clone(),
            parent_session_id: record.parent_session_id.clone(),
        }
    }
}

fn is_explicit_team_root(session: &OwnershipSessionShape) -> bool {
    if session.specialist_id.as_deref() == Some(TEAM_LEAD_SPECIALIST_ID) {
        return true;
    }
    let is_routa = session
        .role
        .as_deref()
        .is_some_and(|role| role.eq_ignore_ascii_case("ROUTA"));
    let name = session.name.as_deref().unwrap_or_default().to_lowercase();
    is_routa
        && (name.starts_with("team -")
            || name.starts_with("team run")
            || name.contains("team lead"))
}

/// Resolve a session to its root Team session. Broken, cyclic, or
/// cross-workspace parent chains intentionally return `None`.
pub fn resolve_owning_team_run_id(
    session_id: Option<&str>,
    sessions: &[OwnershipSessionShape],
) -> Option<String> {
    let session_id = session_id?;
    let start = sessions.iter().find(|item| item.session_id == session_id)?;
    let by_id: HashMap<&str, &OwnershipSessionShape> = sessions
        .iter()
        .filter(|item| item.workspace_id == start.workspace_id)
        .map(|item| (item.session_id.as_str(), item))
        .collect();

    let mut current = start;
    let mut visited = HashSet::new();
    let mut walked_parent = false;
    while let Some(parent_id) = current.parent_session_id.as_deref() {
        if !visited.insert(current.session_id.as_str()) {
            return None;
        }
        current = *by_id.get(parent_id)?;
        walked_parent = true;
    }

    let is_routa = current
        .role
        .as_deref()
        .is_some_and(|role| role.eq_ignore_ascii_case("ROUTA"));
    let has_child = sessions.iter().any(|item| {
        item.workspace_id == current.workspace_id
            && item.parent_session_id.as_deref() == Some(current.session_id.as_str())
    });
    (is_explicit_team_root(current) || (is_routa && (walked_parent || has_child)))
        .then(|| current.session_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, parent: Option<&str>, role: &str) -> OwnershipSessionShape {
        OwnershipSessionShape {
            session_id: id.to_string(),
            workspace_id: "default".to_string(),
            name: None,
            role: Some(role.to_string()),
            specialist_id: None,
            parent_session_id: parent.map(str::to_string),
        }
    }

    #[test]
    fn child_resolves_to_routa_root() {
        let sessions = vec![
            session("root", None, "ROUTA"),
            session("child", Some("root"), "CRAFTER"),
            session("grandchild", Some("child"), "GATE"),
        ];
        assert_eq!(
            resolve_owning_team_run_id(Some("grandchild"), &sessions).as_deref(),
            Some("root")
        );
    }

    #[test]
    fn explicit_team_lead_root_resolves_to_itself() {
        let mut root = session("root", None, "ROUTA");
        root.specialist_id = Some(TEAM_LEAD_SPECIALIST_ID.to_string());
        assert_eq!(
            resolve_owning_team_run_id(Some("root"), &[root]).as_deref(),
            Some("root")
        );
    }

    #[test]
    fn ordinary_session_is_not_a_team_run() {
        assert_eq!(
            resolve_owning_team_run_id(Some("plain"), &[session("plain", None, "ROUTA")]),
            None
        );
    }

    #[test]
    fn broken_or_cyclic_chain_is_rejected() {
        let broken = vec![session("child", Some("missing"), "CRAFTER")];
        assert_eq!(resolve_owning_team_run_id(Some("child"), &broken), None);

        let cyclic = vec![
            session("a", Some("b"), "CRAFTER"),
            session("b", Some("a"), "CRAFTER"),
        ];
        assert_eq!(resolve_owning_team_run_id(Some("a"), &cyclic), None);
    }
}
