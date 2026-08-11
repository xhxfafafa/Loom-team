import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────
// The collector reads durable state through ports; the pure envelope builders
// are tested without any mocks.

const storeStub = vi.hoisted(() => ({
  getHistory: vi.fn((): unknown[] => []),
  getConsolidatedHistory: vi.fn((): unknown[] | undefined => undefined),
  listSessions: vi.fn((): unknown[] => []),
  hydrateFromDb: vi.fn(async () => {}),
}));

const loadHistoryFromDbMock = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));

const systemStub = vi.hoisted(() => ({
  taskStore: {
    listByWorkspace: vi.fn(async (): Promise<unknown[]> => []),
    listByAssignee: vi.fn(async (_agentId: string): Promise<unknown[]> => []),
  },
  agentStore: {
    get: vi.fn(async () => undefined),
  },
}));

vi.mock("@/core/acp/http-session-store", () => ({
  getHttpSessionStore: () => storeStub,
}));

vi.mock("@/core/acp/session-db-persister", () => ({
  loadHistoryFromDb: loadHistoryFromDbMock,
}));

vi.mock("@/core/routa-system", () => ({
  getRoutaSystem: () => systemStub,
}));

const {
  RECOVERY_ENVELOPE_SCHEMA,
  DEFAULT_RECOVERY_ENVELOPE_LIMITS,
  buildRecoveryEnvelope,
  renderRecoveryEnvelope,
  collectRecoveryEnvelope,
  setPendingRecoveryContext,
  consumePendingRecoveryContext,
  clearPendingRecoveryContextsForTest,
} = await import("../recovery-context");

// ── Fixtures ────────────────────────────────────────────────────────────────

function taskFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    title: "Build parser",
    objective: "Implement the parser",
    status: "IN_PROGRESS",
    assignedTo: "agent-child-1",
    teamRunId: "lead-1",
    workspaceId: "ws-1",
    sessionIds: [],
    updatedAt: new Date("2026-08-11T09:00:00.000Z"),
    ...overrides,
  };
}

function historyEntry(
  sessionUpdate: string,
  text: string,
  eventId?: string,
): Record<string, unknown> {
  return {
    sessionId: "lead-1",
    ...(eventId ? { eventId } : {}),
    update: {
      sessionUpdate,
      ...(text ? { content: { type: "text", text } } : {}),
    },
  };
}

const LEAD_SESSION = {
  sessionId: "lead-1",
  name: "Team - Demo Run",
  role: "ROUTA",
  specialistId: "team-agent-lead",
  workspaceId: "ws-1",
  cwd: "/repo",
};

const CHILD_SESSION = {
  sessionId: "child-1",
  role: "CRAFTER",
  routaAgentId: "agent-child-1",
  parentSessionId: "lead-1",
  workspaceId: "ws-1",
  cwd: "/repo",
};

// ── buildRecoveryEnvelope: bounded selection ────────────────────────────────

describe("buildRecoveryEnvelope", () => {
  it("keeps session facts and returns empty selections without team input", () => {
    const envelope = buildRecoveryEnvelope({
      session: { sessionId: "solo-1", provider: "opencode", cwd: "/w", workspaceId: "ws-1" },
    });

    expect(envelope.schema).toBe(RECOVERY_ENVELOPE_SCHEMA);
    expect(envelope.session).toMatchObject({ sessionId: "solo-1", cwd: "/w" });
    expect(envelope.team).toBeUndefined();
    expect(envelope.recentHistory).toEqual([]);
    expect(envelope.droppedHistoryCount).toBe(0);
  });

  it("prioritizes unfinished tasks, caps the selection, and counts what was dropped", () => {
    const envelope = buildRecoveryEnvelope({
      session: { sessionId: "s", workspaceId: "ws-1" },
      team: {
        tasks: [
          { id: "t-done-1", title: "done 1", status: "COMPLETED" },
          { id: "t-open-1", title: "open 1", status: "IN_PROGRESS" },
          { id: "t-done-2", title: "done 2", status: "CANCELLED" },
          { id: "t-open-2", title: "open 2", status: "BLOCKED" },
          { id: "t-open-3", title: "open 3", status: "NEEDS_FIX" },
        ],
        members: [],
        reports: [],
      },
      limits: { maxTasks: 3 },
    });

    const team = envelope.team;
    expect(team).toBeDefined();
    // Unfinished tasks come first (stable order), then terminal ones — capped.
    expect(team?.tasks.map((task) => task.id)).toEqual(["t-open-1", "t-open-2", "t-open-3"]);
    expect(team?.totalTasks).toBe(5);
    expect(team?.unfinishedTaskCount).toBe(3);
    expect(team?.droppedTaskCount).toBe(2);
  });

  it("caps members, keeps the most recent reports, and truncates long text", () => {
    const longText = "x".repeat(DEFAULT_RECOVERY_ENVELOPE_LIMITS.maxTextChars + 50);
    const envelope = buildRecoveryEnvelope({
      session: { sessionId: "s", workspaceId: "ws-1" },
      team: {
        tasks: [],
        members: [
          { agentId: "m-1" },
          { agentId: "m-2" },
          { agentId: "m-3" },
        ],
        reports: [
          { deliveryId: "r-0", text: "old report" },
          { deliveryId: "r-1", text: "newer report" },
          { deliveryId: "r-2", text: longText },
        ],
      },
      limits: { maxMembers: 2, maxReports: 2 },
    });

    const team = envelope.team;
    expect(team?.members.map((member) => member.agentId)).toEqual(["m-1", "m-2"]);
    expect(team?.totalMembers).toBe(3);
    expect(team?.droppedMemberCount).toBe(1);
    // Most recent reports win.
    expect(team?.reports.map((report) => report.deliveryId)).toEqual(["r-1", "r-2"]);
    expect(team?.totalReports).toBe(3);
    const longSummary = team?.reports.find((report) => report.deliveryId === "r-2")?.summary ?? "";
    expect(longSummary.length).toBeLessThanOrEqual(DEFAULT_RECOVERY_ENVELOPE_LIMITS.maxTextChars);
    expect(longSummary.endsWith("…")).toBe(true);
  });

  it("keeps the most recent bounded history and counts dropped entries", () => {
    const envelope = buildRecoveryEnvelope({
      session: { sessionId: "s" },
      history: [
        { role: "user", text: "first" },
        { role: "assistant", text: "second" },
        { role: "user", text: "third" },
        { role: "assistant", text: "fourth" },
      ],
      limits: { maxHistoryEntries: 2 },
    });

    expect(envelope.recentHistory.map((entry) => entry.text)).toEqual(["third", "fourth"]);
    expect(envelope.droppedHistoryCount).toBe(2);
  });

  it("derives blocking issues from BLOCKED and NEEDS_FIX tasks", () => {
    const envelope = buildRecoveryEnvelope({
      session: { sessionId: "s" },
      team: {
        tasks: [
          { id: "t-1", title: "stuck", status: "BLOCKED" },
          { id: "t-2", title: "broken", status: "NEEDS_FIX" },
          { id: "t-3", title: "fine", status: "IN_PROGRESS" },
        ],
        members: [],
        reports: [],
      },
    });

    expect(envelope.team?.blockingIssues).toEqual([
      { taskId: "t-1", title: "stuck", status: "BLOCKED" },
      { taskId: "t-2", title: "broken", status: "NEEDS_FIX" },
    ]);
  });
});

// ── renderRecoveryEnvelope ──────────────────────────────────────────────────

describe("renderRecoveryEnvelope", () => {
  it("wraps the envelope in a clearly marked internal block that is not a user message", () => {
    const rendered = renderRecoveryEnvelope(buildRecoveryEnvelope({
      session: { sessionId: "s-1", provider: "claude", role: "CRAFTER", cwd: "/repo", branch: "main", workspaceId: "ws-1" },
    }));

    expect(rendered.startsWith(`<routa-internal-recovery-context schema="${RECOVERY_ENVELOPE_SCHEMA}">`)).toBe(true);
    expect(rendered.trimEnd().endsWith("</routa-internal-recovery-context>")).toBe(true);
    expect(rendered).toContain("NOT a user message");
    expect(rendered).toContain("s-1");
    expect(rendered).toContain("/repo");
    expect(rendered).toContain("main");
    expect(rendered).toContain("ws-1");
  });

  it("renders team objective, tasks, members, reports, and blocking issues deterministically", () => {
    const envelope = buildRecoveryEnvelope({
      session: { sessionId: "lead-1", provider: "claude", role: "ROUTA", cwd: "/repo", workspaceId: "ws-1" },
      team: {
        objective: "Build the demo feature end to end",
        leadPolicyPrompt: "LEAD POLICY PROMPT",
        tasks: [
          { id: "t-open", title: "Open task", status: "IN_PROGRESS", objective: "Do the thing" },
          { id: "t-blocked", title: "Blocked task", status: "BLOCKED" },
        ],
        members: [
          { agentId: "agent-child-1", sessionId: "child-1", role: "CRAFTER", taskId: "t-open", taskTitle: "Open task", taskStatus: "IN_PROGRESS" },
        ],
        reports: [
          { deliveryId: "team-report:lead-1:child-1:t-open:0", childSessionId: "child-1", taskId: "t-open", text: "Report body" },
        ],
      },
      history: [
        { role: "user", text: "Keep going" },
        { role: "assistant", text: "On it" },
      ],
    });

    const first = renderRecoveryEnvelope(envelope);
    const second = renderRecoveryEnvelope(envelope);
    expect(first).toBe(second);

    expect(first).toContain("Build the demo feature end to end");
    expect(first).toContain("LEAD POLICY PROMPT");
    expect(first).toContain("Open task");
    expect(first).toContain("IN_PROGRESS");
    expect(first).toContain("agent-child-1");
    expect(first).toContain("Report body");
    expect(first).toContain("Blocked task");
    expect(first).toContain("Keep going");
    expect(first).toContain("On it");
  });
});

// ── pending recovery context channel (exactly-once) ─────────────────────────

describe("pending recovery context channel", () => {
  beforeEach(() => {
    clearPendingRecoveryContextsForTest();
  });

  it("returns the pending context exactly once and never again", () => {
    setPendingRecoveryContext("session-1", "RECOVERY CONTEXT");

    expect(consumePendingRecoveryContext("session-1")).toBe("RECOVERY CONTEXT");
    expect(consumePendingRecoveryContext("session-1")).toBeUndefined();
  });

  it("returns undefined when nothing is pending and ignores blank text", () => {
    expect(consumePendingRecoveryContext("session-x")).toBeUndefined();
    setPendingRecoveryContext("session-x", "   ");
    expect(consumePendingRecoveryContext("session-x")).toBeUndefined();
  });
});

// ── collectRecoveryEnvelope: durable team context ───────────────────────────

describe("collectRecoveryEnvelope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeStub.getHistory.mockReturnValue([]);
    storeStub.getConsolidatedHistory.mockReturnValue(undefined);
    storeStub.listSessions.mockReturnValue([]);
    storeStub.hydrateFromDb.mockResolvedValue(undefined);
    loadHistoryFromDbMock.mockResolvedValue([]);
    systemStub.taskStore.listByWorkspace.mockResolvedValue([]);
    systemStub.taskStore.listByAssignee.mockResolvedValue([]);
  });

  it("collects objective, tasks, members, reports, and blocking issues for a Team Lead session", async () => {
    storeStub.listSessions.mockReturnValue([LEAD_SESSION, CHILD_SESSION]);
    storeStub.getHistory.mockReturnValue([
      historyEntry("user_message", "Build the demo feature end to end"),
      historyEntry("agent_message", "Delegating task-1 to child-1"),
      historyEntry(
        "user_message",
        "## Agent Completion Report\nTask done",
        "team-report:lead-1:child-1:task-1:0",
      ),
      historyEntry("delivery_receipt", "", "team-report:lead-1:child-1:task-1:0:delivered"),
    ]);
    systemStub.taskStore.listByWorkspace.mockResolvedValue([
      taskFixture(),
      taskFixture({ id: "task-2", title: "Deploy", objective: "Ship it", status: "BLOCKED", assignedTo: undefined }),
      taskFixture({ id: "task-3", title: "Setup", objective: "Setup repo", status: "COMPLETED" }),
      taskFixture({ id: "task-9", title: "Foreign", status: "PENDING", teamRunId: "other-run" }),
    ]);
    systemStub.taskStore.listByAssignee.mockImplementation(async (agentId: string) =>
      agentId === "agent-child-1" ? [taskFixture()] : [],
    );

    const envelope = await collectRecoveryEnvelope({
      sessionId: "lead-1",
      provider: "claude",
      role: "ROUTA",
      cwd: "/repo",
      workspaceId: "ws-1",
      specialistId: "team-agent-lead",
      specialistSystemPrompt: "LEAD POLICY",
    });

    expect(envelope).toBeDefined();
    expect(envelope?.session).toMatchObject({
      sessionId: "lead-1",
      provider: "claude",
      role: "ROUTA",
      cwd: "/repo",
      workspaceId: "ws-1",
    });

    const team = envelope?.team;
    expect(team).toBeDefined();
    expect(team?.teamRunId).toBe("lead-1");
    // The objective is the first genuine user message of the Lead (never a
    // Team report delivery).
    expect(team?.objective).toBe("Build the demo feature end to end");
    expect(team?.leadPolicyPrompt).toBe("LEAD POLICY");

    // Unfinished tasks first; foreign-team tasks excluded.
    expect(team?.tasks.map((task) => task.id)).toEqual(["task-1", "task-2", "task-3"]);
    expect(team?.totalTasks).toBe(3);
    expect(team?.unfinishedTaskCount).toBe(2);

    expect(team?.members).toEqual([
      expect.objectContaining({
        agentId: "agent-child-1",
        sessionId: "child-1",
        role: "CRAFTER",
        taskId: "task-1",
        taskTitle: "Build parser",
        taskStatus: "IN_PROGRESS",
      }),
    ]);

    expect(team?.reports.map((report) => report.deliveryId)).toEqual([
      "team-report:lead-1:child-1:task-1:0",
    ]);
    expect(team?.reports[0]?.childSessionId).toBe("child-1");
    expect(team?.reports[0]?.taskId).toBe("task-1");
    expect(team?.reports[0]?.summary).toContain("Agent Completion Report");

    expect(team?.blockingIssues).toEqual([
      { taskId: "task-2", title: "Deploy", status: "BLOCKED" },
    ]);

    // Recent history excludes Team report deliveries (they surface as reports).
    expect(envelope?.recentHistory.map((entry) => entry.text)).toEqual([
      "Build the demo feature end to end",
      "Delegating task-1 to child-1",
    ]);
  });

  it("omits team context for sessions that are not part of a Team Run", async () => {
    storeStub.listSessions.mockReturnValue([
      { sessionId: "solo-1", role: "CRAFTER", workspaceId: "ws-1", cwd: "/repo" },
    ]);
    storeStub.getHistory.mockReturnValue([
      historyEntry("user_message", "hello"),
      historyEntry("agent_message", "hi there"),
    ]);

    const envelope = await collectRecoveryEnvelope({
      sessionId: "solo-1",
      provider: "opencode",
      role: "CRAFTER",
      cwd: "/repo",
      workspaceId: "ws-1",
    });

    expect(envelope).toBeDefined();
    expect(envelope?.team).toBeUndefined();
    expect(envelope?.recentHistory.map((entry) => entry.text)).toEqual(["hello", "hi there"]);
  });

  it("bounds the collected history with the configured limits", async () => {
    storeStub.listSessions.mockReturnValue([
      { sessionId: "solo-1", role: "CRAFTER", workspaceId: "ws-1", cwd: "/repo" },
    ]);
    const entries = [];
    for (let index = 0; index < 30; index += 1) {
      entries.push(historyEntry(index % 2 === 0 ? "user_message" : "agent_message", `message ${index}`));
    }
    storeStub.getHistory.mockReturnValue(entries);

    const envelope = await collectRecoveryEnvelope({
      sessionId: "solo-1",
      cwd: "/repo",
      workspaceId: "ws-1",
      limits: { maxHistoryEntries: 4 },
    });

    expect(envelope?.recentHistory).toHaveLength(4);
    expect(envelope?.recentHistory.map((entry) => entry.text)).toEqual([
      "message 26",
      "message 27",
      "message 28",
      "message 29",
    ]);
    expect(envelope?.droppedHistoryCount).toBe(26);
  });

  it("returns undefined instead of failing recovery when collection throws", async () => {
    storeStub.listSessions.mockImplementation(() => {
      throw new Error("store exploded");
    });

    const envelope = await collectRecoveryEnvelope({
      sessionId: "broken-1",
      cwd: "/repo",
      workspaceId: "ws-1",
    });

    // A collection failure degrades to "no envelope"; recovery proceeds.
    expect(envelope === undefined || envelope.team === undefined).toBe(true);
  });
});
