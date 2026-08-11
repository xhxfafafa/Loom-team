import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { hydrateFromDb, listSessions, hasActiveSession } = vi.hoisted(() => ({
  hydrateFromDb: vi.fn(),
  listSessions: vi.fn(),
  hasActiveSession: vi.fn(),
}));

vi.mock("@/core/acp/http-session-store", () => ({
  getHttpSessionStore: () => ({
    hydrateFromDb,
    listSessions,
  }),
}));

vi.mock("@/core/acp/processer", () => ({
  getAcpProcessManager: () => ({
    hasActiveSession,
  }),
}));

import { GET } from "../route";
import { TEAM_LEAD_SPECIALIST_ID } from "../team-run";

describe("/api/sessions GET", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hydrateFromDb.mockResolvedValue(undefined);
    hasActiveSession.mockReturnValue(false);
    listSessions.mockReturnValue([
      {
        sessionId: "session-3",
        name: "Session 3",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        branch: "main",
        provider: "codex",
        role: "DEVELOPER",
        toolMode: "full",
        allowedNativeTools: ["Bash"],
        createdAt: "2026-04-03T10:02:00.000Z",
      },
      {
        sessionId: "session-2",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        createdAt: "2026-04-03T10:01:00.000Z",
      },
      {
        sessionId: "session-1",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        createdAt: "2026-04-03T10:00:00.000Z",
      },
      {
        sessionId: "child-2",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        createdAt: "2026-04-03T09:59:30.000Z",
        parentSessionId: "parent-1",
      },
      {
        sessionId: "child-1",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        createdAt: "2026-04-03T09:59:15.000Z",
        parentSessionId: "parent-1",
        firstPromptSent: false,
      },
      {
        sessionId: "session-other-workspace",
        workspaceId: "workspace-2",
        cwd: "/tmp/project",
        createdAt: "2026-04-03T09:59:00.000Z",
      },
      {
        sessionId: "session-empty",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        createdAt: "2026-04-03T09:58:00.000Z",
        firstPromptSent: false,
      },
    ]);
  });

  it("filters by workspace and honors limit", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/sessions?workspaceId=workspace-1&limit=2"),
    );
    const data = await response.json();

    expect(hydrateFromDb).toHaveBeenCalledTimes(1);
    expect(data.sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual([
      "session-3",
      "session-2",
    ]);
    expect(data.sessions[0]).toMatchObject({
      sessionId: "session-3",
      name: "Session 3",
      branch: "main",
      provider: "codex",
      role: "DEVELOPER",
    });
    expect(data.sessions[0].toolMode).toBeUndefined();
    expect(data.sessions[0].allowedNativeTools).toBeUndefined();
  });

  it("keeps child session queries inclusive but still honors limit", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/sessions?parentSessionId=parent-1&limit=1"),
    );
    const data = await response.json();

    expect(data.sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual([
      "child-2",
    ]);
  });

  it("returns stable team-run summaries for explicit team runs and anonymous top-level ROUTA runs with descendants", async () => {
    listSessions.mockReturnValue([
      {
        sessionId: "anonymous-team-run",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        role: "ROUTA",
        createdAt: "2026-04-03T10:05:00.000Z",
      },
      {
        sessionId: "anonymous-team-child",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        role: "DEVELOPER",
        parentSessionId: "anonymous-team-run",
        createdAt: "2026-04-03T10:04:00.000Z",
      },
      {
        sessionId: "named-team-run",
        name: "Team - Investigate regression",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        role: "ROUTA",
        createdAt: "2026-04-03T10:03:00.000Z",
      },
      {
        sessionId: "named-non-routa-run",
        name: "Team - not actually routa",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        role: "DEVELOPER",
        createdAt: "2026-04-03T10:02:30.000Z",
      },
      {
        sessionId: "non-team-routa",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        role: "ROUTA",
        createdAt: "2026-04-03T10:02:00.000Z",
      },
      {
        sessionId: "team-specialist-run",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        specialistId: TEAM_LEAD_SPECIALIST_ID,
        createdAt: "2026-04-03T10:01:00.000Z",
      },
      {
        sessionId: "session-other-workspace",
        workspaceId: "workspace-2",
        cwd: "/tmp/project",
        role: "ROUTA",
        createdAt: "2026-04-03T10:00:00.000Z",
      },
    ]);

    const response = await GET(
      new NextRequest("http://localhost/api/sessions?workspaceId=workspace-1&surface=team"),
    );
    const data = await response.json();

    expect(data.sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual([
      "anonymous-team-run",
      "named-team-run",
      "team-specialist-run",
    ]);
    expect(data.sessions[0]).toMatchObject({
      sessionId: "anonymous-team-run",
      directDelegates: 1,
      descendants: 1,
    });
    expect(data.sessions[1]).toMatchObject({
      sessionId: "named-team-run",
      directDelegates: 0,
      descendants: 0,
    });
  });

  it("exposes teamChainId on team-run summaries and omits it for legacy runs", async () => {
    listSessions.mockReturnValue([
      {
        sessionId: "chain-run",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        specialistId: TEAM_LEAD_SPECIALIST_ID,
        teamChainId: "standard_delivery",
        createdAt: "2026-04-03T10:05:00.000Z",
      },
      {
        sessionId: "legacy-run",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        specialistId: TEAM_LEAD_SPECIALIST_ID,
        createdAt: "2026-04-03T10:04:00.000Z",
      },
    ]);

    const response = await GET(
      new NextRequest("http://localhost/api/sessions?workspaceId=workspace-1&surface=team"),
    );
    const data = await response.json();

    const chainRun = data.sessions.find((s: { sessionId: string }) => s.sessionId === "chain-run");
    const legacyRun = data.sessions.find((s: { sessionId: string }) => s.sessionId === "legacy-run");
    expect(chainRun.teamChainId).toBe("standard_delivery");
    expect(legacyRun.teamChainId).toBeUndefined();
  });

  it("ignores cyclic descendants and excludes named non-ROUTA sessions from the team surface", async () => {
    listSessions.mockReturnValue([
      {
        sessionId: "cycle-root",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        role: "ROUTA",
        createdAt: "2026-04-03T10:05:00.000Z",
      },
      {
        sessionId: "cycle-child",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        role: "DEVELOPER",
        parentSessionId: "cycle-root",
        createdAt: "2026-04-03T10:04:00.000Z",
      },
      {
        sessionId: "cycle-root",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        role: "DEVELOPER",
        parentSessionId: "cycle-child",
        createdAt: "2026-04-03T10:03:00.000Z",
      },
      {
        sessionId: "named-non-routa-run",
        name: "Team - not actually routa",
        workspaceId: "workspace-1",
        cwd: "/tmp/project",
        role: "DEVELOPER",
        createdAt: "2026-04-03T10:02:30.000Z",
      },
    ]);

    const response = await GET(
      new NextRequest("http://localhost/api/sessions?workspaceId=workspace-1&surface=team"),
    );
    const data = await response.json();

    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]).toMatchObject({
      sessionId: "cycle-root",
      directDelegates: 1,
      descendants: 1,
    });
  });

  describe("continuityStatus derivation", () => {
    const freshTimestamp = () => new Date().toISOString();

    it("reports active only for sessions with a live runtime", async () => {
      hasActiveSession.mockImplementation((sessionId: string) => sessionId === "live-session");
      listSessions.mockReturnValue([
        {
          sessionId: "live-session",
          workspaceId: "workspace-1",
          cwd: "/tmp/project",
          provider: "claude",
          acpStatus: "ready",
          createdAt: freshTimestamp(),
        },
      ]);

      const response = await GET(
        new NextRequest("http://localhost/api/sessions?workspaceId=workspace-1"),
      );
      const data = await response.json();

      expect(data.sessions[0].continuityStatus).toBe("active");
    });

    it("does not report a persisted ready status as active after the runtime dies", async () => {
      // Regression: before the recovery rework, a stale acpStatus=ready from a
      // dead instance kept the session classified as active.
      hasActiveSession.mockReturnValue(false);
      listSessions.mockReturnValue([
        {
          sessionId: "dead-but-ready",
          workspaceId: "workspace-1",
          cwd: "/tmp/project",
          provider: "claude",
          acpStatus: "ready",
          createdAt: freshTimestamp(),
        },
        {
          sessionId: "dead-connecting",
          workspaceId: "workspace-1",
          cwd: "/tmp/project",
          provider: "codex",
          acpStatus: "connecting",
          createdAt: freshTimestamp(),
        },
      ]);

      const response = await GET(
        new NextRequest("http://localhost/api/sessions?workspaceId=workspace-1"),
      );
      const data = await response.json();

      const byId = new Map<string, { sessionId: string; continuityStatus?: string }>(
        data.sessions.map((s: { sessionId: string; continuityStatus?: string }) => [s.sessionId, s]),
      );
      expect(byId.get("dead-but-ready")?.continuityStatus).toBe("restorable");
      expect(byId.get("dead-connecting")?.continuityStatus).toBe("restorable");
    });

    it("keeps runner-owned sessions active while their last live status is ready", async () => {
      hasActiveSession.mockReturnValue(false);
      listSessions.mockReturnValue([
        {
          sessionId: "runner-session",
          workspaceId: "workspace-1",
          cwd: "/tmp/project",
          provider: "opencode",
          acpStatus: "ready",
          executionMode: "runner",
          createdAt: freshTimestamp(),
        },
      ]);

      const response = await GET(
        new NextRequest("http://localhost/api/sessions?workspaceId=workspace-1"),
      );
      const data = await response.json();

      expect(data.sessions[0].continuityStatus).toBe("active");
    });
  });
});
