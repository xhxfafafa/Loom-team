//! Contract tests for `GET /api/tasks?teamRunId=` — Team Run task filtering
//! with workspace isolation (design doc: team-task-lifecycle-consistency).

use reqwest::StatusCode;
use serde_json::{json, Value};

#[path = "common/mod.rs"]
mod common;
use common::ApiFixture;

#[tokio::test]
async fn api_tasks_filter_by_team_run_id_with_workspace_isolation() {
    let fixture = ApiFixture::new().await;

    // Second workspace for the isolation assertion.
    let create_workspace = fixture
        .client
        .post(fixture.endpoint("/api/workspaces"))
        .json(&json!({"title":"Team Run Isolation Workspace"}))
        .send()
        .await
        .expect("create workspace");
    assert_eq!(create_workspace.status(), StatusCode::OK);
    let workspace_json: Value = create_workspace
        .json()
        .await
        .expect("decode workspace response");
    let other_workspace_id = workspace_json["workspace"]["id"]
        .as_str()
        .expect("workspace id")
        .to_string();

    // Two tasks in the default workspace, two in the isolated workspace: one
    // bound to the team run in each workspace, one unbound in each.
    let mut task_ids = Vec::new();
    for (workspace_id, title) in [
        ("default".to_string(), "Team Run Task A"),
        ("default".to_string(), "Unbound Default Task"),
        (other_workspace_id.clone(), "Team Run Task C"),
        (other_workspace_id.clone(), "Unbound Isolated Task"),
    ] {
        let create_task = fixture
            .client
            .post(fixture.endpoint("/api/tasks"))
            .json(&json!({
                "title": title,
                "objective": "Exercise the teamRunId filter",
                "workspaceId": workspace_id,
                "columnId": "blocked"
            }))
            .send()
            .await
            .expect("create task");
        assert_eq!(create_task.status(), StatusCode::CREATED);
        let created: Value = create_task.json().await.expect("decode task response");
        task_ids.push((
            created["task"]["id"].as_str().expect("task id").to_string(),
            title.to_string(),
            workspace_id,
        ));
    }

    // Delegation bindings write team_run_id through the task store; seed the
    // same binding value directly so this contract test can focus on the read
    // filter. The "Unbound" tasks stay unbound and must never match.
    {
        let db = rusqlite::Connection::open(&fixture.db_path).expect("open fixture db");
        for (task_id, _title, _workspace_id) in task_ids.iter().step_by(2) {
            let changed = db
                .execute(
                    "UPDATE tasks SET team_run_id = ?1 WHERE id = ?2",
                    rusqlite::params!["team-run-alpha", task_id],
                )
                .expect("seed team_run_id");
            assert_eq!(changed, 1);
        }
    }

    // Positive: default workspace lists exactly its bound task, not the
    // unbound neighbour.
    let positive = fixture
        .client
        .get(fixture.endpoint("/api/tasks?workspaceId=default&teamRunId=team-run-alpha"))
        .send()
        .await
        .expect("list tasks by teamRunId");
    assert_eq!(positive.status(), StatusCode::OK);
    let positive_json: Value = positive.json().await.expect("decode list response");
    let positive_titles: Vec<String> = positive_json["tasks"]
        .as_array()
        .expect("tasks array")
        .iter()
        .map(|task| task["title"].as_str().expect("task title").to_string())
        .collect();
    assert_eq!(positive_titles, vec!["Team Run Task A".to_string()]);
    for task in positive_json["tasks"].as_array().expect("tasks array") {
        assert_eq!(task["teamRunId"].as_str(), Some("team-run-alpha"));
    }

    // Workspace isolation: the other workspace only sees its own bound task.
    let isolated = fixture
        .client
        .get(fixture.endpoint(&format!(
            "/api/tasks?workspaceId={other_workspace_id}&teamRunId=team-run-alpha"
        )))
        .send()
        .await
        .expect("list isolated tasks by teamRunId");
    assert_eq!(isolated.status(), StatusCode::OK);
    let isolated_json: Value = isolated.json().await.expect("decode isolated response");
    let isolated_titles: Vec<String> = isolated_json["tasks"]
        .as_array()
        .expect("tasks array")
        .iter()
        .map(|task| task["title"].as_str().expect("task title").to_string())
        .collect();
    assert_eq!(isolated_titles, vec!["Team Run Task C".to_string()]);

    // Negative: an unknown teamRunId returns an empty list, not an error.
    let negative = fixture
        .client
        .get(fixture.endpoint("/api/tasks?workspaceId=default&teamRunId=team-run-missing"))
        .send()
        .await
        .expect("list tasks for unknown teamRunId");
    assert_eq!(negative.status(), StatusCode::OK);
    let negative_json: Value = negative.json().await.expect("decode negative response");
    assert_eq!(
        negative_json["tasks"]
            .as_array()
            .expect("tasks array")
            .len(),
        0
    );
}
