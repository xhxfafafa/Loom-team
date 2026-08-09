//! Local folder import API - /api/clone/local and workspace codebases.
//!
//! Covers the "git is optional" contract for local projects:
//! - plain (non-git) directories can be loaded and added as codebases
//! - git repositories keep full git metadata (branch/status)
//! - missing paths, file paths, and unreadable paths are rejected clearly

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use reqwest::StatusCode;
use serde_json::{json, Value};
use tempfile::TempDir;

#[path = "common/mod.rs"]
mod common;
use common::ApiFixture;

struct FolderFixture {
    _temp: TempDir,
    path: PathBuf,
}

impl FolderFixture {
    fn plain_dir() -> Self {
        let temp = tempfile::tempdir().expect("tempdir should exist");
        let path = temp.path().join("plain-project");
        fs::create_dir_all(&path).expect("plain dir should be created");
        fs::write(path.join("notes.txt"), "hello from a plain folder\n")
            .expect("sample file should be written");
        Self { _temp: temp, path }
    }

    fn git_repo() -> Self {
        let temp = tempfile::tempdir().expect("tempdir should exist");
        let path = temp.path().join("git-project");
        fs::create_dir_all(&path).expect("git dir should be created");

        run_git(&path, &["init", "--no-bare", "-b", "main"]);
        run_git(&path, &["config", "user.name", "Routa Test"]);
        run_git(&path, &["config", "user.email", "routa-test@example.com"]);
        fs::write(path.join("README.md"), "# git project\n").expect("README should be written");
        run_git(&path, &["add", "README.md"]);
        run_git(&path, &["commit", "-m", "chore: initial commit"]);

        Self { _temp: temp, path }
    }

    fn file_instead_of_dir() -> Self {
        let temp = tempfile::tempdir().expect("tempdir should exist");
        let path = temp.path().join("not-a-dir.txt");
        fs::write(&path, "this is a file, not a folder\n").expect("file should be written");
        Self { _temp: temp, path }
    }
}

fn run_git(repo_path: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_path)
        .output()
        .unwrap_or_else(|err| panic!("git {:?} should run: {err}", args));
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr).trim()
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

async fn clone_local(fixture: &ApiFixture, path: &str) -> (StatusCode, Value) {
    let response = fixture
        .client
        .post(fixture.endpoint("/api/clone/local"))
        .json(&json!({ "path": path }))
        .send()
        .await
        .expect("clone/local request should complete");
    let status = response.status();
    let body: Value = response.json().await.expect("decode clone/local response");
    (status, body)
}

#[tokio::test]
async fn clone_local_accepts_plain_folder_without_git() {
    let fixture = ApiFixture::new().await;
    let folder = FolderFixture::plain_dir();

    let (status, body) = clone_local(&fixture, &folder.path.to_string_lossy()).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["success"], json!(true));
    assert_eq!(body["git"], json!(false));
    assert_eq!(body["name"], json!("plain-project"));
    assert_eq!(body["path"], json!(folder.path.to_string_lossy()));
    // No git metadata is produced for a plain folder, and no git command ran.
    assert_eq!(body["branch"], json!(""));
    assert_eq!(body["branches"], json!([]));
    assert_eq!(body["status"]["clean"], json!(true));
    assert_eq!(body["status"]["modified"], json!(0));
}

#[tokio::test]
async fn clone_local_still_returns_git_metadata_for_git_repositories() {
    let fixture = ApiFixture::new().await;
    let repo = FolderFixture::git_repo();

    let (status, body) = clone_local(&fixture, &repo.path.to_string_lossy()).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["git"], json!(true));
    assert_eq!(body["branch"], json!("main"));
    assert_eq!(body["branches"], json!(["main"]));
    assert_eq!(body["status"]["clean"], json!(true));
}

#[tokio::test]
async fn plain_folder_can_be_added_as_workspace_codebase() {
    let fixture = ApiFixture::new().await;
    let folder = FolderFixture::plain_dir();

    let create_response = fixture
        .client
        .post(fixture.endpoint("/api/workspaces/default/codebases"))
        .json(&json!({
            "repoPath": folder.path.to_string_lossy().to_string(),
            "label": "Plain folder project"
        }))
        .send()
        .await
        .expect("create plain folder codebase");
    assert_eq!(create_response.status(), StatusCode::CREATED);
    let create_json: Value = create_response
        .json()
        .await
        .expect("decode codebase response");
    assert_eq!(
        create_json["codebase"]["repoPath"],
        json!(folder.path.to_string_lossy())
    );
    assert_eq!(create_json["codebase"]["isDefault"], json!(true));

    // The workspace changes view degrades gracefully for non-git codebases:
    // it reports the missing git context instead of failing or running git.
    let changes_response = fixture
        .client
        .get(fixture.endpoint("/api/workspaces/default/codebases/changes"))
        .send()
        .await
        .expect("list codebase changes");
    assert_eq!(changes_response.status(), StatusCode::OK);
    let changes_json: Value = changes_response
        .json()
        .await
        .expect("decode codebase changes");
    let repos = changes_json["repos"]
        .as_array()
        .expect("repos list should exist");
    assert_eq!(repos.len(), 1);
    assert_eq!(
        repos[0]["error"],
        json!("Repository is missing or not a git repository")
    );
    assert_eq!(repos[0]["files"], json!([]));
}

#[tokio::test]
async fn clone_local_rejects_missing_file_and_unreadable_paths() {
    let fixture = ApiFixture::new().await;
    let file_fixture = FolderFixture::file_instead_of_dir();

    // Missing path
    let missing = file_fixture.path.parent().unwrap().join("does-not-exist");
    let (status, body) = clone_local(&fixture, &missing.to_string_lossy()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]
            .as_str()
            .is_some_and(|error| error.starts_with("Local folder does not exist:")),
        "unexpected error: {body}"
    );

    // File instead of directory
    let (status, body) = clone_local(&fixture, &file_fixture.path.to_string_lossy()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]
            .as_str()
            .is_some_and(|error| error.starts_with("Path is not a directory:")),
        "unexpected error: {body}"
    );

    // Unreadable directory (chmod 000). When the test runs with elevated
    // privileges the permission check is bypassed by the OS; skip that case.
    let temp = tempfile::tempdir().expect("tempdir should exist");
    let locked = temp.path().join("locked");
    fs::create_dir_all(&locked).expect("locked dir should be created");
    let mut permissions = fs::metadata(&locked).expect("metadata").permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o000);
    }
    fs::set_permissions(&locked, permissions).expect("chmod 000 should apply");
    let permission_bypassed = fs::read_dir(&locked).is_ok();

    let (status, body) = clone_local(&fixture, &locked.to_string_lossy()).await;
    if permission_bypassed {
        eprintln!("skipping unreadable-path assertion: permissions are bypassed (elevated user)");
        assert_eq!(status, StatusCode::OK);
    } else {
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]
                .as_str()
                .is_some_and(|error| error.starts_with("Local folder is not readable:")),
            "unexpected error: {body}"
        );
    }

    // Restore permissions so TempDir cleanup can remove the folder.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut restore = fs::metadata(&locked).expect("metadata").permissions();
        restore.set_mode(0o755);
        let _ = fs::set_permissions(&locked, restore);
    }
}
