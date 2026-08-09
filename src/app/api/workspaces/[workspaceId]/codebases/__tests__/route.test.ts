import { beforeEach, describe, expect, it, vi } from "vitest";

const codebaseStore = {
  listByWorkspace: vi.fn(),
  update: vi.fn(),
  findByRepoPath: vi.fn(),
  countByWorkspace: vi.fn(),
  add: vi.fn(),
};

vi.mock("@/core/routa-system", () => ({
  getRoutaSystem: () => ({ codebaseStore }),
}));

const gitMocks = vi.hoisted(() => ({
  normalizeLocalRepoPath: vi.fn((value: string) => value),
  validateRepoInput: vi.fn(),
  isBareGitRepository: vi.fn(),
  migrateLegacyManagedClone: vi.fn((value: string) => value),
}));

vi.mock("@/core/git", () => gitMocks);

import { NextRequest } from "next/server";
import { GET, POST } from "../route";

function buildRequest(body: unknown) {
  return new NextRequest("http://localhost/api/workspaces/ws-1/codebases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ workspaceId: "ws-1" }) };

describe("POST /api/workspaces/[workspaceId]/codebases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitMocks.normalizeLocalRepoPath.mockImplementation((value: string) => value);
    gitMocks.isBareGitRepository.mockReturnValue(false);
    gitMocks.migrateLegacyManagedClone.mockImplementation((value: string) => value);
    codebaseStore.listByWorkspace.mockResolvedValue([]);
    codebaseStore.update.mockResolvedValue(undefined);
    codebaseStore.findByRepoPath.mockResolvedValue(null);
    codebaseStore.countByWorkspace.mockResolvedValue(0);
    codebaseStore.add.mockResolvedValue(undefined);
  });

  it("adds a plain non-git folder as a codebase", async () => {
    gitMocks.validateRepoInput.mockReturnValue({ valid: true, isGit: false, isBareGit: false });

    const response = await POST(buildRequest({ repoPath: "/tmp/plain-folder" }), params);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.codebase.repoPath).toBe("/tmp/plain-folder");
    expect(data.codebase.workspaceId).toBe("ws-1");
    expect(data.codebase.isDefault).toBe(true);
    expect(codebaseStore.add).toHaveBeenCalledTimes(1);
  });

  it("still adds a git repository as a codebase", async () => {
    gitMocks.validateRepoInput.mockReturnValue({ valid: true, isGit: true, isBareGit: false });

    const response = await POST(
      buildRequest({ repoPath: "/tmp/git-repo", branch: "main" }),
      params,
    );
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.codebase.repoPath).toBe("/tmp/git-repo");
    expect(data.codebase.branch).toBe("main");
  });

  it("rejects a folder that does not exist", async () => {
    gitMocks.validateRepoInput.mockReturnValue({
      valid: false,
      errorCode: "not_found",
      error: "Local folder does not exist: /tmp/missing",
    });

    const response = await POST(buildRequest({ repoPath: "/tmp/missing" }), params);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Local folder does not exist: /tmp/missing");
    expect(data.errorCode).toBe("not_found");
    expect(codebaseStore.add).not.toHaveBeenCalled();
  });

  it("rejects a path that points at a file", async () => {
    gitMocks.validateRepoInput.mockReturnValue({
      valid: false,
      errorCode: "not_a_directory",
      error: "Path is not a directory: /tmp/some-file.txt",
    });

    const response = await POST(buildRequest({ repoPath: "/tmp/some-file.txt" }), params);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.errorCode).toBe("not_a_directory");
    expect(codebaseStore.add).not.toHaveBeenCalled();
  });

  it("rejects a folder without read permission", async () => {
    gitMocks.validateRepoInput.mockReturnValue({
      valid: false,
      errorCode: "not_readable",
      error: "Local folder is not readable: /tmp/locked",
    });

    const response = await POST(buildRequest({ repoPath: "/tmp/locked" }), params);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.errorCode).toBe("not_readable");
    expect(codebaseStore.add).not.toHaveBeenCalled();
  });

  it("rejects bare git repositories", async () => {
    gitMocks.validateRepoInput.mockReturnValue({ valid: true, isGit: true, isBareGit: true });
    gitMocks.isBareGitRepository.mockReturnValue(true);

    const response = await POST(buildRequest({ repoPath: "/tmp/bare-repo.git" }), params);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Cannot add a bare git repository as a codebase");
    expect(codebaseStore.add).not.toHaveBeenCalled();
  });

  it("requires repoPath", async () => {
    const response = await POST(buildRequest({}), params);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("repoPath is required");
  });
});

describe("GET /api/workspaces/[workspaceId]/codebases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codebaseStore.update.mockResolvedValue(undefined);
  });

  it("persists the detached path when a legacy managed clone is migrated", async () => {
    codebaseStore.listByWorkspace.mockResolvedValue([{
      id: "cb-1",
      workspaceId: "ws-1",
      repoPath: "/host/routa/.routa/repos/owner--personal",
      branch: "main",
      label: "owner/personal",
      isDefault: true,
      createdAt: new Date("2026-08-10T00:00:00Z"),
      updatedAt: new Date("2026-08-10T00:00:00Z"),
    }]);
    gitMocks.migrateLegacyManagedClone.mockReturnValue("/home/user/.routa/repos/owner--personal");

    const response = await GET(new NextRequest("http://localhost"), params);
    const data = await response.json();

    expect(codebaseStore.update).toHaveBeenCalledWith("cb-1", {
      repoPath: "/home/user/.routa/repos/owner--personal",
    });
    expect(data.codebases[0].repoPath).toBe("/home/user/.routa/repos/owner--personal");
  });
});
