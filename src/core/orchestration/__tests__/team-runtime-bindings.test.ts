import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Team runtime bindings must be rebuilt purely from durable records:
 * parent_session_id tree, routa_agent_id, and the task store. Restoration
 * must never invent, overwrite, or conflate IDs.
 */

const fakeOrchestrator = vi.hoisted(() => ({
  registerAgentSession: vi.fn(),
  setNotificationHandler: vi.fn(),
  setSessionRegistrationHandler: vi.fn(),
  restoreTeamRuntimeState: vi.fn(),
}));

const fakeStore = vi.hoisted(() => ({
  hydrateFromDb: vi.fn(async () => {}),
  listSessions: vi.fn((): unknown[] => []),
  upsertSession: vi.fn(),
  pushNotification: vi.fn(),
}));

const pushAndPersistForwardedNotificationMock = vi.hoisted(() => vi.fn());
const buildExecutionBindingMock = vi.hoisted(() => vi.fn(() => ({ executionMode: "embedded" as const })));
const persistSessionToDbMock = vi.hoisted(() => vi.fn(async () => {}));
const listByAssigneeMock = vi.hoisted(() =>
  vi.fn(async (_agentId: string) => [] as unknown[]));

vi.mock("@/core/acp/http-session-store", () => ({
  getHttpSessionStore: () => fakeStore,
}));

vi.mock("@/core/acp/forwarded-notification", () => ({
  pushAndPersistForwardedNotification: pushAndPersistForwardedNotificationMock,
}));

vi.mock("@/core/acp/execution-backend", () => ({
  buildExecutionBinding: buildExecutionBindingMock,
}));

vi.mock("@/core/acp/session-db-persister", () => ({
  persistSessionToDb: persistSessionToDbMock,
}));

vi.mock("@/core/routa-system", () => ({
  getRoutaSystem: () => ({ taskStore: { listByAssignee: listByAssigneeMock } }),
}));

vi.mock("@/core/orchestration/orchestrator-singleton", () => ({
  initRoutaOrchestrator: () => fakeOrchestrator,
}));

const { installTeamOrchestrationHandlers, restoreTeamRuntimeBindings } = await import(
  "../team-runtime-bindings"
);

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    cwd: "/workspace",
    workspaceId: "ws-1",
    provider: "claude",
    role: "CRAFTER",
    createdAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("restoreTeamRuntimeBindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeStore.listSessions.mockReturnValue([]);
    listByAssigneeMock.mockResolvedValue([]);
  });

  it("does nothing for non-ROUTA sessions", async () => {
    const result = await restoreTeamRuntimeBindings({
      sessionId: "plain-session",
      role: "CRAFTER",
      routaAgentId: "routa-agent-1",
    });

    expect(result).toEqual({ restored: false, restoredSessions: 0, restoredChildRecords: 0 });
    expect(fakeOrchestrator.registerAgentSession).not.toHaveBeenCalled();
    expect(fakeOrchestrator.setNotificationHandler).not.toHaveBeenCalled();
  });

  it("restores Lead mapping, descendant mappings, and child records from durable state", async () => {
    fakeStore.listSessions.mockReturnValue([
      makeSession({
        sessionId: "lead-session",
        routaAgentId: "routa-lead",
        role: "ROUTA",
        specialistId: "team-agent-lead",
        provider: "claude-code-sdk",
      }),
      makeSession({
        sessionId: "child-session",
        routaAgentId: "routa-child",
        parentSessionId: "lead-session",
        specialistId: "team-backend-dev",
      }),
      makeSession({
        sessionId: "grandchild-session",
        routaAgentId: "routa-grandchild",
        parentSessionId: "child-session",
      }),
      // Outside the team tree: must not be restored.
      makeSession({ sessionId: "unrelated-session", routaAgentId: "routa-other" }),
    ]);
    listByAssigneeMock.mockImplementation(async (agentId: string) => {
      if (agentId === "routa-child") {
        return [
          { id: "task-1", workspaceId: "ws-1", status: "COMPLETED", updatedAt: "2026-08-11T01:00:00.000Z" },
        ];
      }
      if (agentId === "routa-grandchild") {
        return [
          { id: "task-2", workspaceId: "ws-1", status: "IN_PROGRESS", updatedAt: "2026-08-11T02:00:00.000Z" },
        ];
      }
      return [];
    });

    const result = await restoreTeamRuntimeBindings({
      sessionId: "lead-session",
      role: "ROUTA",
      workspaceId: "ws-1",
      routaAgentId: "routa-lead",
      specialistId: "team-agent-lead",
      cwd: "/workspace",
    });

    expect(result.restored).toBe(true);
    expect(result.mcpProfile).toBe("team-coordination");
    expect(result.restoredSessions).toBe(2);
    expect(result.restoredChildRecords).toBe(2);

    // Lead + both descendants are re-registered with their durable IDs only.
    expect(fakeOrchestrator.restoreTeamRuntimeState).toHaveBeenCalledTimes(1);
    const restorePlan = fakeOrchestrator.restoreTeamRuntimeState.mock.calls[0][0];
    expect(restorePlan.agentSessions).toEqual(expect.arrayContaining([
      { agentId: "routa-lead", sessionId: "lead-session" },
      { agentId: "routa-child", sessionId: "child-session" },
      { agentId: "routa-grandchild", sessionId: "grandchild-session" },
    ]));
    expect(restorePlan.agentSessions).not.toContainEqual({
      agentId: "routa-other",
      sessionId: "unrelated-session",
    });
    expect(restorePlan.notificationHandler).toEqual(expect.any(Function));
    expect(restorePlan.sessionRegistrationHandler).toEqual(expect.any(Function));

    // Child records carry durable linkage; a terminal task is already handled.
    const restoredRecords = restorePlan.childAgents;
    const childRecord = restoredRecords.find((r: { agentId: string }) => r.agentId === "routa-child");
    expect(childRecord).toMatchObject({
      sessionId: "child-session",
      parentAgentId: "routa-lead",
      parentSessionId: "lead-session",
      taskId: "task-1",
      completionHandled: true,
      workspaceId: "ws-1",
    });
    const grandchildRecord = restoredRecords.find((r: { agentId: string }) => r.agentId === "routa-grandchild");
    expect(grandchildRecord).toMatchObject({
      parentSessionId: "child-session",
      taskId: "task-2",
      completionHandled: false,
    });
  });

  it("derives no mcpProfile for ROUTA sessions without the team-agent-lead specialist", async () => {
    fakeStore.listSessions.mockReturnValue([
      makeSession({ sessionId: "routa-session", routaAgentId: "routa-lead", role: "ROUTA" }),
    ]);

    const result = await restoreTeamRuntimeBindings({
      sessionId: "routa-session",
      role: "ROUTA",
      routaAgentId: "routa-lead",
    });

    expect(result.restored).toBe(true);
    expect(result.mcpProfile).toBeUndefined();
  });

  it("returns restored:false without throwing when loading the session tree fails", async () => {
    fakeStore.listSessions.mockImplementation(() => {
      throw new Error("store offline");
    });

    const result = await restoreTeamRuntimeBindings({
      sessionId: "lead-session",
      role: "ROUTA",
      routaAgentId: "routa-lead",
    });

    expect(result.restored).toBe(false);
    // P1 all-or-nothing: a failed restoration must be REPORTED structurally —
    // silently returning `restored: false` let recovery start a chat-only
    // runtime. The function still must not throw (the recovery caller decides
    // how to surface the structured failure).
    expect(result.failure).toMatchObject({ code: "team_bindings_incomplete" });
    expect(result.failure?.message).toContain("store offline");
  });
});

// ─── P1-2: Team binding restoration is all-or-nothing ──────────────────────
// A ROUTA restoration either rebuilds ALL coordination bindings (Lead agent
// mapping, descendant session mappings, child records, notification handler,
// child-session-registration handler, Team MCP profile) or reports a
// structured failure. It must never partially restore and never hide a
// failure — recovery refuses to start a chat-only runtime on either.

describe("restoreTeamRuntimeBindings all-or-nothing (P1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeStore.listSessions.mockReturnValue([]);
    listByAssigneeMock.mockResolvedValue([]);
  });

  it("reports missing team metadata (not a partial restore) when routaAgentId is absent", async () => {
    const result = await restoreTeamRuntimeBindings({
      sessionId: "lead-session",
      role: "ROUTA",
      workspaceId: "ws-1",
      // No durable routaAgentId: the Lead agent mapping cannot be rebuilt.
    });

    expect(result.restored).toBe(false);
    expect(result.failure).toMatchObject({
      code: "missing_team_metadata",
      missingMetadata: ["routaAgentId"],
    });
    expect(result.failure?.message).toBeTruthy();
    // All-or-nothing: no partial bindings may be installed on failure.
    expect(fakeOrchestrator.registerAgentSession).not.toHaveBeenCalled();
    expect(fakeOrchestrator.setNotificationHandler).not.toHaveBeenCalled();
    expect(fakeOrchestrator.setSessionRegistrationHandler).not.toHaveBeenCalled();
  });

  it("reports a structured failure (never silent) when the durable tree cannot be loaded", async () => {
    fakeStore.hydrateFromDb.mockRejectedValueOnce(new Error("db offline"));

    const result = await restoreTeamRuntimeBindings({
      sessionId: "lead-session",
      role: "ROUTA",
      routaAgentId: "routa-lead",
    });

    expect(result.restored).toBe(false);
    expect(result.failure?.code).toBe("team_bindings_incomplete");
    expect(result.failure?.message).toContain("db offline");
    // Nothing may be registered from an unloadable tree.
    expect(fakeOrchestrator.registerAgentSession).not.toHaveBeenCalled();
  });

  it("reports unmapped descendants instead of registering a partial team tree", async () => {
    fakeStore.listSessions.mockReturnValue([
      makeSession({
        sessionId: "lead-session",
        routaAgentId: "routa-lead",
        role: "ROUTA",
      }),
      makeSession({
        sessionId: "child-ok",
        routaAgentId: "routa-child",
        parentSessionId: "lead-session",
      }),
      // A durable descendant row without a logical agent ID: its session
      // mapping cannot be restored from durable state.
      makeSession({ sessionId: "child-orphan", parentSessionId: "lead-session" }),
    ]);

    const result = await restoreTeamRuntimeBindings({
      sessionId: "lead-session",
      role: "ROUTA",
      workspaceId: "ws-1",
      routaAgentId: "routa-lead",
    });

    expect(result.restored).toBe(false);
    expect(result.failure).toMatchObject({
      code: "team_bindings_incomplete",
      unmappedSessionIds: ["child-orphan"],
    });
    expect(result.failure?.missingBindings).toContain("child_session_mappings");
    // All-or-nothing: NOTHING is registered when the tree is incomplete.
    expect(fakeOrchestrator.registerAgentSession).not.toHaveBeenCalled();
  });

  it("reports failed handler installation as a structured binding failure", async () => {
    fakeOrchestrator.restoreTeamRuntimeState.mockImplementationOnce(() => {
      throw new Error("orchestrator sealed");
    });

    const result = await restoreTeamRuntimeBindings({
      sessionId: "lead-session",
      role: "ROUTA",
      routaAgentId: "routa-lead",
    });

    expect(result.restored).toBe(false);
    expect(result.failure?.code).toBe("team_bindings_incomplete");
    expect(result.failure?.missingBindings).toEqual(
      expect.arrayContaining(["notification_handler", "child_session_registration_handler"]),
    );
    expect(result.failure?.message).toContain("orchestrator sealed");
    expect(fakeOrchestrator.registerAgentSession).not.toHaveBeenCalled();
    expect(fakeOrchestrator.setNotificationHandler).not.toHaveBeenCalled();
    expect(fakeOrchestrator.setSessionRegistrationHandler).not.toHaveBeenCalled();
  });
});

describe("installTeamOrchestrationHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards notifications through the durable push+persist writer", () => {
    installTeamOrchestrationHandlers(fakeOrchestrator as never, fakeStore as never);

    const notificationHandler = fakeOrchestrator.setNotificationHandler.mock.calls[0][0];
    notificationHandler("target-session", { update: { sessionUpdate: "turn_complete" } });

    expect(pushAndPersistForwardedNotificationMock).toHaveBeenCalledWith(
      fakeStore,
      "target-session",
      { update: { sessionUpdate: "turn_complete" } },
    );
  });

  it("registers child sessions in the store and persists them without touching durable IDs", async () => {
    installTeamOrchestrationHandlers(fakeOrchestrator as never, fakeStore as never);

    const registrationHandler = fakeOrchestrator.setSessionRegistrationHandler.mock.calls[0][0];
    registrationHandler({
      sessionId: "child-1",
      name: "Child",
      cwd: "/workspace",
      workspaceId: "ws-1",
      routaAgentId: "routa-child",
      provider: "claude",
      role: "CRAFTER",
      specialistId: "team-backend-dev",
      parentSessionId: "lead-session",
    });

    expect(fakeStore.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "child-1",
        routaAgentId: "routa-child",
        parentSessionId: "lead-session",
        executionMode: "embedded",
      }),
    );
    await vi.waitFor(() => {
      expect(persistSessionToDbMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "child-1",
          routaAgentId: "routa-child",
          parentSessionId: "lead-session",
        }),
      );
    });
  });
});
