import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gitMocks = vi.hoisted(() => ({
  getBranchInfo: vi.fn(),
  getRepoStatus: vi.fn(),
  isGitHubUrl: vi.fn(),
  normalizeLocalRepoPath: vi.fn((value: string) => value),
  validateRepoInput: vi.fn(),
}));

vi.mock("@/core/git", () => gitMocks);

import { POST } from "../route";

function buildRequest(body: unknown) {
  return new NextRequest("http://localhost/api/clone/local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/clone/local", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitMocks.normalizeLocalRepoPath.mockImplementation((value: string) => value);
    gitMocks.isGitHubUrl.mockReturnValue(false);
  });

  it("loads a plain non-git folder without invoking git helpers", async () => {
    gitMocks.validateRepoInput.mockReturnValue({ valid: true, isGit: false, isBareGit: false });

    const response = await POST(buildRequest({ path: "/tmp/plain-folder" }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      success: true,
      name: "plain-folder",
      path: "/tmp/plain-folder",
      git: false,
      branch: "",
      branches: [],
      status: { clean: true, ahead: 0, behind: 0, modified: 0, untracked: 0 },
    });
    expect(gitMocks.getBranchInfo).not.toHaveBeenCalled();
    expect(gitMocks.getRepoStatus).not.toHaveBeenCalled();
  });

  it("loads a git repository with branch info and status", async () => {
    gitMocks.validateRepoInput.mockReturnValue({ valid: true, isGit: true, isBareGit: false });
    gitMocks.getBranchInfo.mockReturnValue({ current: "main", branches: ["main", "dev"] });
    gitMocks.getRepoStatus.mockReturnValue({
      clean: false,
      ahead: 1,
      behind: 0,
      modified: 2,
      untracked: 1,
    });

    const response = await POST(buildRequest({ path: "/tmp/git-repo" }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      success: true,
      name: "git-repo",
      path: "/tmp/git-repo",
      git: true,
      branch: "main",
      branches: ["main", "dev"],
      status: { clean: false, ahead: 1, behind: 0, modified: 2, untracked: 1 },
    });
    expect(gitMocks.getBranchInfo).toHaveBeenCalledWith("/tmp/git-repo");
    expect(gitMocks.getRepoStatus).toHaveBeenCalledWith("/tmp/git-repo");
  });

  it("rejects a folder that does not exist", async () => {
    gitMocks.validateRepoInput.mockReturnValue({
      valid: false,
      errorCode: "not_found",
      error: "Local folder does not exist: /tmp/missing",
    });

    const response = await POST(buildRequest({ path: "/tmp/missing" }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.errorCode).toBe("not_found");
    expect(data.error).toBe("Local folder does not exist: /tmp/missing");
  });

  it("rejects a path that points at a file", async () => {
    gitMocks.validateRepoInput.mockReturnValue({
      valid: false,
      errorCode: "not_a_directory",
      error: "Path is not a directory: /tmp/notes.txt",
    });

    const response = await POST(buildRequest({ path: "/tmp/notes.txt" }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.errorCode).toBe("not_a_directory");
  });

  it("rejects a folder without read permission", async () => {
    gitMocks.validateRepoInput.mockReturnValue({
      valid: false,
      errorCode: "not_readable",
      error: "Local folder is not readable: /tmp/locked",
    });

    const response = await POST(buildRequest({ path: "/tmp/locked" }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.errorCode).toBe("not_readable");
  });

  it("rejects bare git repositories", async () => {
    gitMocks.validateRepoInput.mockReturnValue({ valid: true, isGit: true, isBareGit: true });

    const response = await POST(buildRequest({ path: "/tmp/bare-repo.git" }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.errorCode).toBe("bare_repository");
    expect(gitMocks.getBranchInfo).not.toHaveBeenCalled();
  });

  it("requires a path field", async () => {
    const response = await POST(buildRequest({}));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Missing 'path' field");
  });

  it("keeps GitHub URLs on the clone flow", async () => {
    gitMocks.isGitHubUrl.mockReturnValue(true);

    const response = await POST(buildRequest({ path: "https://github.com/owner/repo" }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Use the GitHub clone flow for GitHub URLs");
    expect(gitMocks.validateRepoInput).not.toHaveBeenCalled();
  });
});
