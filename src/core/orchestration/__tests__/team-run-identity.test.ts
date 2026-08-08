import { describe, expect, it } from "vitest";

import {
  buildSessionChildMap,
  collectTeamSessionIds,
  countDescendantSessions,
  hasExplicitTeamRunMarker,
  isTeamRunRoot,
  TEAM_LEAD_SPECIALIST_ID,
  type TeamRunSessionShape,
} from "../team-run-identity";

function session(sessionId: string, extra: Partial<TeamRunSessionShape> = {}): TeamRunSessionShape {
  return { sessionId, ...extra };
}

describe("hasExplicitTeamRunMarker", () => {
  it("marks sessions using the team-agent-lead specialist", () => {
    expect(hasExplicitTeamRunMarker(session("s1", { specialistId: TEAM_LEAD_SPECIALIST_ID }))).toBe(true);
    expect(hasExplicitTeamRunMarker(session("s1", { specialistId: TEAM_LEAD_SPECIALIST_ID, role: "claude" }))).toBe(true);
  });

  it("marks ROUTA sessions with team run / team lead style names", () => {
    expect(hasExplicitTeamRunMarker(session("s1", { role: "ROUTA", name: "Team - Investigate regression" }))).toBe(true);
    expect(hasExplicitTeamRunMarker(session("s1", { role: "routa", name: "team run 2026-08-01" }))).toBe(true);
    expect(hasExplicitTeamRunMarker(session("s1", { role: "ROUTA", name: "Spawned   Team Lead for refactor" }))).toBe(true);
  });

  it("does not mark non-ROUTA sessions even with team-like names", () => {
    expect(hasExplicitTeamRunMarker(session("s1", { role: "claude", name: "Team - Something" }))).toBe(false);
    expect(hasExplicitTeamRunMarker(session("s1", { name: "Team - Something" }))).toBe(false);
  });

  it("does not mark ROUTA sessions without team-like names", () => {
    expect(hasExplicitTeamRunMarker(session("s1", { role: "ROUTA" }))).toBe(false);
    expect(hasExplicitTeamRunMarker(session("s1", { role: "ROUTA", name: "Fix login bug" }))).toBe(false);
    expect(hasExplicitTeamRunMarker(session("s1", { role: "ROUTA", name: "" }))).toBe(false);
  });
});

describe("buildSessionChildMap / collectTeamSessionIds", () => {
  it("collects multi-level descendants with the root first", () => {
    const sessions = [
      session("root"),
      session("child-a", { parentSessionId: "root" }),
      session("child-b", { parentSessionId: "root" }),
      session("grandchild", { parentSessionId: "child-a" }),
      session("unrelated"),
    ];

    const childMap = buildSessionChildMap(sessions);
    expect(childMap.get("root")?.map((child) => child.sessionId)).toEqual(["child-a", "child-b"]);
    expect(childMap.get("child-a")?.map((child) => child.sessionId)).toEqual(["grandchild"]);
    expect(childMap.has("unrelated")).toBe(false);

    const collected = collectTeamSessionIds("root", sessions);
    expect(collected[0]).toBe("root");
    expect(new Set(collected)).toEqual(new Set(["root", "child-a", "child-b", "grandchild"]));
    expect(collected).not.toContain("unrelated");
  });

  it("is cycle-safe", () => {
    const sessions = [
      session("a", { parentSessionId: "b" }),
      session("b", { parentSessionId: "a" }),
    ];
    expect(() => collectTeamSessionIds("a", sessions)).not.toThrow();
    expect(new Set(collectTeamSessionIds("a", sessions))).toEqual(new Set(["a", "b"]));
  });

  it("counts descendants excluding the root", () => {
    const sessions = [
      session("root"),
      session("child", { parentSessionId: "root" }),
      session("grandchild", { parentSessionId: "child" }),
    ];
    expect(countDescendantSessions("root", sessions)).toBe(2);
    expect(countDescendantSessions("child", sessions)).toBe(1);
    expect(countDescendantSessions("grandchild", sessions)).toBe(0);
  });
});

describe("isTeamRunRoot", () => {
  it("accepts top-level explicitly marked sessions", () => {
    const sessions = [session("root", { role: "ROUTA", name: "Team - Alpha" })];
    expect(isTeamRunRoot(sessions[0], sessions)).toBe(true);
  });

  it("accepts top-level ROUTA sessions that have descendants", () => {
    const sessions = [
      session("root", { role: "ROUTA", name: "Plain orchestrator" }),
      session("child", { parentSessionId: "root" }),
    ];
    expect(isTeamRunRoot(sessions[0], sessions)).toBe(true);
  });

  it("rejects child sessions even when marked", () => {
    const sessions = [
      session("root", { role: "ROUTA", name: "Team - Alpha" }),
      session("child", { parentSessionId: "root", specialistId: TEAM_LEAD_SPECIALIST_ID }),
    ];
    expect(isTeamRunRoot(sessions[1], sessions)).toBe(false);
  });

  it("rejects top-level ROUTA sessions without descendants or markers", () => {
    const sessions = [session("solo", { role: "ROUTA", name: "Solo session" })];
    expect(isTeamRunRoot(sessions[0], sessions)).toBe(false);
  });

  it("rejects non-ROUTA sessions with descendants", () => {
    const sessions = [
      session("root", { role: "claude", name: "Not routa" }),
      session("child", { parentSessionId: "root" }),
    ];
    expect(isTeamRunRoot(sessions[0], sessions)).toBe(false);
  });
});
