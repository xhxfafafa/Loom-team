import { describe, expect, it } from "vitest";
import { resolveTeamCardCodebaseId } from "../team-card-codebase";

describe("resolveTeamCardCodebaseId", () => {
  it("uses the Team root cwd instead of the current or default repository", () => {
    const codebaseId = resolveTeamCardCodebaseId(
      {
        id: "task-team",
        title: "Team Story",
        status: "TODO",
        createdAt: "2025-01-01T00:00:00.000Z",
        teamRunId: "team-root",
        triggerSessionId: "child-session",
        codebaseIds: ["codebase-personal"],
      },
      new Map([
        ["team-root", { cwd: "/repo/loom" }],
        ["child-session", { cwd: "/repo/personal" }],
      ]),
      [
        { id: "codebase-personal", repoPath: "/repo/personal" },
        { id: "codebase-loom", repoPath: "/repo/loom" },
      ],
    );

    expect(codebaseId).toBe("codebase-loom");
  });

  it("does not fall back when the root cwd is not a registered codebase", () => {
    expect(resolveTeamCardCodebaseId(
      {
        id: "task-team",
        title: "Team Story",
        status: "TODO",
        teamRunId: "team-root",
        createdAt: "2025-01-01T00:00:00.000Z",
      },
      new Map([["team-root", { cwd: "/repo/missing" }]]),
      [{ id: "codebase-personal", repoPath: "/repo/personal" }],
    )).toBeUndefined();
  });
});
