import { describe, expect, it } from "vitest";
import type { SessionInfo, TaskInfo } from "../../types";
import {
  getPreferredTaskSessionId,
  hasActiveTaskSession,
  isTaskSessionLive,
} from "../kanban-tab-helpers";

function buildTask(overrides?: Partial<TaskInfo>): TaskInfo {
  return {
    id: "task-1",
    title: "Session gate fixture",
    objective: "Gate Run on runtime state, not historical sessions.",
    status: "IN_PROGRESS",
    boardId: "board-1",
    columnId: "dev",
    position: 0,
    priority: "medium",
    labels: [],
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildSession(overrides?: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: "session-1",
    cwd: "/repo",
    workspaceId: "workspace-1",
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function sessionMapOf(sessions: SessionInfo[]): Map<string, SessionInfo> {
  return new Map(sessions.map((session) => [session.sessionId, session]));
}

describe("isTaskSessionLive", () => {
  it("treats active continuity as live regardless of persisted acpStatus", () => {
    expect(isTaskSessionLive(buildSession({ acpStatus: "ready", continuityStatus: "active" }))).toBe(true);
  });

  it("treats a persisted ready status from a dead process as not live", () => {
    expect(isTaskSessionLive(buildSession({ acpStatus: "ready", continuityStatus: "restorable" }))).toBe(false);
    expect(isTaskSessionLive(buildSession({ acpStatus: "ready", continuityStatus: "interrupted" }))).toBe(false);
    expect(isTaskSessionLive(buildSession({ acpStatus: "ready", continuityStatus: "stale" }))).toBe(false);
  });

  it("falls back to acpStatus when continuity is unknown", () => {
    expect(isTaskSessionLive(buildSession({ acpStatus: "ready" }))).toBe(true);
    expect(isTaskSessionLive(buildSession({ acpStatus: "connecting" }))).toBe(true);
    expect(isTaskSessionLive(buildSession({ acpStatus: "error" }))).toBe(false);
  });

  it("never treats error sessions as live even when continuity claims active", () => {
    expect(isTaskSessionLive(buildSession({ acpStatus: "error", continuityStatus: "active" }))).toBe(false);
  });

  it("treats missing sessions as not live", () => {
    expect(isTaskSessionLive(undefined)).toBe(false);
  });
});

describe("hasActiveTaskSession", () => {
  it("returns false for tasks without sessions", () => {
    expect(hasActiveTaskSession(buildTask(), sessionMapOf([]))).toBe(false);
    expect(hasActiveTaskSession(null, sessionMapOf([]))).toBe(false);
  });

  it("detects a live trigger session", () => {
    const task = buildTask({ triggerSessionId: "session-trigger" });
    const sessions = sessionMapOf([
      buildSession({ sessionId: "session-trigger", acpStatus: "ready", continuityStatus: "active" }),
    ]);
    expect(hasActiveTaskSession(task, sessions)).toBe(true);
  });

  it("detects a live lane session even when it is not the trigger session", () => {
    const task = buildTask({
      triggerSessionId: "session-dead",
      laneSessions: [{ sessionId: "session-lane", columnId: "dev", startedAt: "2025-01-01T00:00:00.000Z", transport: "acp", status: "completed" }],
    });
    const sessions = sessionMapOf([
      buildSession({ sessionId: "session-dead", acpStatus: "ready", continuityStatus: "stale" }),
      buildSession({ sessionId: "session-lane", acpStatus: "connecting", continuityStatus: "active" }),
    ]);
    expect(hasActiveTaskSession(task, sessions)).toBe(true);
  });

  it("returns false when every recorded session is dead — retry must stay possible", () => {
    const task = buildTask({
      triggerSessionId: "session-dead",
      sessionIds: ["session-dead", "session-child"],
      laneSessions: [{ sessionId: "session-child", columnId: "dev", startedAt: "2025-01-01T00:00:00.000Z", transport: "acp", status: "completed" }],
    });
    const sessions = sessionMapOf([
      buildSession({ sessionId: "session-dead", acpStatus: "ready", continuityStatus: "restorable" }),
      buildSession({ sessionId: "session-child", acpStatus: "error", continuityStatus: "stale" }),
    ]);
    expect(hasActiveTaskSession(task, sessions)).toBe(false);
  });

  it("returns false when the session id is not present in the session map", () => {
    const task = buildTask({ triggerSessionId: "session-unknown" });
    expect(hasActiveTaskSession(task, sessionMapOf([]))).toBe(false);
  });
});

describe("getPreferredTaskSessionId", () => {
  it("prefers the trigger session for display", () => {
    const task = buildTask({
      triggerSessionId: "session-trigger",
      sessionIds: ["session-child"],
      laneSessions: [{ sessionId: "session-lane", columnId: "dev", startedAt: "2025-01-01T00:00:00.000Z", transport: "acp", status: "completed" }],
    });
    expect(getPreferredTaskSessionId(task)).toBe("session-trigger");
  });

  it("falls back to the latest lane session, then the latest child session", () => {
    expect(getPreferredTaskSessionId(buildTask({
      laneSessions: [
        { sessionId: "session-lane-1", columnId: "dev", startedAt: "2025-01-01T00:00:00.000Z", transport: "acp", status: "completed" },
        { sessionId: "session-lane-2", columnId: "review", startedAt: "2025-01-02T00:00:00.000Z", transport: "acp", status: "completed" },
      ],
      sessionIds: ["session-child"],
    }))).toBe("session-lane-2");

    expect(getPreferredTaskSessionId(buildTask({ sessionIds: ["session-child-1", "session-child-2"] })))
      .toBe("session-child-2");
  });

  it("returns null when the task owns no session", () => {
    expect(getPreferredTaskSessionId(buildTask())).toBeNull();
    expect(getPreferredTaskSessionId(null)).toBeNull();
  });
});
