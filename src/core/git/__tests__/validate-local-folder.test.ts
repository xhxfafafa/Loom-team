import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(),
  statSync: vi.fn<(path: string) => { isDirectory: boolean; isFile: boolean }>(),
  readDirSync: vi.fn<(path: string) => unknown[]>(),
}));

const gitExecMock = vi.hoisted(() => vi.fn());

vi.mock("@/core/platform", () => ({
  getServerBridge: () => ({
    env: {
      homeDir: () => "/home/user",
      currentDir: () => "/workspace",
    },
    fs: fsMocks,
  }),
}));

vi.mock("@/core/utils/safe-exec", () => ({
  gitExec: gitExecMock,
}));

const { validateRepoInput } = await import("../git-utils");

function mockReadableDirectory() {
  fsMocks.existsSync.mockReturnValue(true);
  fsMocks.statSync.mockReturnValue({ isDirectory: true, isFile: false });
  fsMocks.readDirSync.mockReturnValue([]);
}

function mockGitRepository(isGit: boolean, isBare = false) {
  gitExecMock.mockImplementation((args: string[]) => {
    if (args[0] === "rev-parse" && args[1] === "--git-dir") {
      if (!isGit) throw new Error("not a git repository");
      return ".git";
    }
    if (args[0] === "rev-parse" && args[1] === "--is-bare-repository") {
      if (!isGit) throw new Error("not a git repository");
      return isBare ? "true" : "false";
    }
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  });
}

describe("validateRepoInput local folder semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a plain directory that is not a git repository", () => {
    mockReadableDirectory();
    mockGitRepository(false);

    const result = validateRepoInput("/tmp/plain-folder");

    expect(result.valid).toBe(true);
    expect(result.isGit).toBe(false);
    expect(result.isBareGit).toBe(false);
  });

  it("accepts a git working repository and reports isGit", () => {
    mockReadableDirectory();
    mockGitRepository(true);

    const result = validateRepoInput("/tmp/git-repo");

    expect(result.valid).toBe(true);
    expect(result.isGit).toBe(true);
    expect(result.isBareGit).toBe(false);
  });

  it("flags bare git repositories", () => {
    mockReadableDirectory();
    mockGitRepository(true, true);

    const result = validateRepoInput("/tmp/bare-repo.git");

    expect(result.valid).toBe(true);
    expect(result.isGit).toBe(true);
    expect(result.isBareGit).toBe(true);
  });

  it("rejects a path that does not exist", () => {
    fsMocks.existsSync.mockReturnValue(false);

    const result = validateRepoInput("/tmp/missing");

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("not_found");
    expect(result.error).toContain("/tmp/missing");
    expect(gitExecMock).not.toHaveBeenCalled();
  });

  it("rejects a path that points at a file", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.statSync.mockReturnValue({ isDirectory: false, isFile: true });

    const result = validateRepoInput("/tmp/notes.txt");

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("not_a_directory");
    expect(gitExecMock).not.toHaveBeenCalled();
  });

  it("rejects a directory that cannot be read", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.statSync.mockReturnValue({ isDirectory: true, isFile: false });
    fsMocks.readDirSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const result = validateRepoInput("/tmp/locked");

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("not_readable");
    expect(gitExecMock).not.toHaveBeenCalled();
  });

  it("still parses GitHub URLs", () => {
    const result = validateRepoInput("https://github.com/owner/repo");

    expect(result.valid).toBe(true);
    expect(result.isGitHub).toBe(true);
    expect(fsMocks.existsSync).not.toHaveBeenCalled();
  });

  it("rejects empty input", () => {
    const result = validateRepoInput("   ");

    expect(result.valid).toBe(false);
  });
});
