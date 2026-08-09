import { describe, expect, it } from "vitest";

import {
  resolveOwningTeamRunId,
  resolveOwningTeamRunIdFromSessions,
  type OwnershipSessionShape,
} from "../team-run-ownership";

function session(
  sessionId: string,
  extra: Partial<OwnershipSessionShape> = {},
): OwnershipSessionShape {
  return {
    sessionId,
    workspaceId: "ws-1",
    parentSessionId: undefined,
    ...extra,
  };
}

/** A Team Lead root: explicit specialist marker, no parent. */
function teamRoot(sessionId: string, workspaceId = "ws-1"): OwnershipSessionShape {
  return session(sessionId, { specialistId: "team-agent-lead", workspaceId });
}

describe("resolveOwningTeamRunId", () => {
  it("returns the Team root's own ID when the session is the root", () => {
    const sessions = [teamRoot("root-1"), session("solo-1", { role: "claude" })];

    expect(resolveOwningTeamRunId("root-1", sessions)).toBe("root-1");
  });

  it("walks a sub-agent session up to the top-level Team root", () => {
    const sessions = [
      teamRoot("root-1"),
      session("child-1", { parentSessionId: "root-1", role: "claude" }),
      session("grandchild-1", { parentSessionId: "child-1", role: "codex" }),
    ];

    expect(resolveOwningTeamRunId("child-1", sessions)).toBe("root-1");
    expect(resolveOwningTeamRunId("grandchild-1", sessions)).toBe("root-1");
  });

  it("returns undefined for normal sessions that are not part of a Team Run", () => {
    const sessions = [
      teamRoot("root-1"),
      session("solo-1", { role: "claude" }),
      // Non-ROUTA root with descendants is not a Team root.
      session("parent-1", { role: "claude", name: "Regular parent" }),
      session("kid-1", { parentSessionId: "parent-1", role: "claude" }),
    ];

    expect(resolveOwningTeamRunId("solo-1", sessions)).toBeUndefined();
    expect(resolveOwningTeamRunId("parent-1", sessions)).toBeUndefined();
    expect(resolveOwningTeamRunId("kid-1", sessions)).toBeUndefined();
  });

  it("accepts a ROUTA root with descendants as a Team root", () => {
    const sessions = [
      session("routa-root", { role: "ROUTA", name: "Coordinator" }),
      session("child-1", { parentSessionId: "routa-root", role: "claude" }),
    ];

    expect(resolveOwningTeamRunId("child-1", sessions)).toBe("routa-root");
  });

  it("does not guess ownership for sessions missing from the list", () => {
    const sessions = [teamRoot("root-1")];

    expect(resolveOwningTeamRunId("ghost", sessions)).toBeUndefined();
    expect(resolveOwningTeamRunId(undefined, sessions)).toBeUndefined();
  });

  it("returns undefined on a broken parent chain", () => {
    const sessions = [
      teamRoot("root-1"),
      session("orphan-1", { parentSessionId: "missing-parent", role: "claude" }),
    ];

    expect(resolveOwningTeamRunId("orphan-1", sessions)).toBeUndefined();
  });

  it("returns undefined on parent cycles instead of looping forever", () => {
    const sessions = [
      session("a", { parentSessionId: "b", role: "claude" }),
      session("b", { parentSessionId: "a", role: "claude" }),
    ];

    expect(resolveOwningTeamRunId("a", sessions)).toBeUndefined();
    expect(resolveOwningTeamRunId("b", sessions)).toBeUndefined();
  });

  it("stops at workspace boundaries and never resolves across workspaces", () => {
    const sessions = [
      teamRoot("root-1", "ws-1"),
      // Same parent ID but recorded in another workspace: the walk must stop.
      session("child-1", { parentSessionId: "root-1", workspaceId: "ws-2", role: "claude" }),
    ];

    expect(resolveOwningTeamRunId("child-1", sessions)).toBeUndefined();
  });

  it("never attributes normal sessions by name similarity", () => {
    const sessions = [
      teamRoot("root-1"),
      // Looks team-ish by name but is not ROUTA, has no marker, and no parent
      // chain into the team — must stay unowned.
      session("fake-team", { name: "Team - Impostor", role: "claude" }),
    ];

    expect(resolveOwningTeamRunId("fake-team", sessions)).toBeUndefined();
  });
});

describe("resolveOwningTeamRunIdFromSessions", () => {
  it("resolves through an async session lister", async () => {
    const sessions = [
      teamRoot("root-1"),
      session("child-1", { parentSessionId: "root-1" }),
    ];

    await expect(
      resolveOwningTeamRunIdFromSessions("child-1", async () => sessions),
    ).resolves.toBe("root-1");
  });

  it("returns undefined when the lister throws instead of guessing", async () => {
    await expect(
      resolveOwningTeamRunIdFromSessions("child-1", async () => {
        throw new Error("session store exploded");
      }),
    ).resolves.toBeUndefined();
  });

  it("short-circuits without calling the lister when sessionId is empty", async () => {
    let called = false;
    await expect(
      resolveOwningTeamRunIdFromSessions(undefined, () => {
        called = true;
        return [];
      }),
    ).resolves.toBeUndefined();
    expect(called).toBe(false);
  });
});
