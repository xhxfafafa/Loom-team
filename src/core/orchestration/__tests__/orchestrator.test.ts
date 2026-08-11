import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentRole, AgentStatus, ModelTier, createAgent } from "@/core/models/agent";
import { TaskStatus, VerificationVerdict, createTask } from "@/core/models/task";

const specialistByRoleMock = vi.hoisted(() => vi.fn());
const specialistByIdMock = vi.hoisted(() => vi.fn());
const buildDelegationPromptMock = vi.hoisted(() => vi.fn(() => "delegation prompt"));
const checkDelegationDepthMock = vi.hoisted(() => vi.fn());
const calculateChildDepthMock = vi.hoisted(() => vi.fn((depth: number) => depth + 1));
const buildAgentMetadataMock = vi.hoisted(() => vi.fn());
const uuidMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());
const hydrateFromDbMock = vi.hoisted(() => vi.fn(async () => {}));
const listSessionsMock = vi.hoisted(() => vi.fn(() => [] as Array<Record<string, unknown>>));
const recordDelegationMock = vi.hoisted(() => vi.fn(async () => {}));
const recordChildSessionStartMock = vi.hoisted(() => vi.fn(async () => {}));
const recordChildCompletionMock = vi.hoisted(() => vi.fn(async () => {}));
const AgentMemoryWriterMock = vi.hoisted(() =>
  vi.fn(function MockAgentMemoryWriter() {
    return {
      recordDelegation: recordDelegationMock,
      recordChildSessionStart: recordChildSessionStartMock,
      recordChildCompletion: recordChildCompletionMock,
    };
  }),
);
const appendSessionNotificationEventOnceMock = vi.hoisted(() =>
  vi.fn(async (): Promise<
    | { status: "appended" }
    | { status: "duplicate" }
    | { status: "session_not_found" }
    | { status: "unavailable"; error: string }
  > => ({ status: "appended" })));
const loadHistorySinceEventIdFromDbMock = vi.hoisted(() =>
  vi.fn(async (): Promise<Array<{ eventId?: string }>> => []),
);
const finalizeSessionRuntimeMock = vi.hoisted(() =>
  vi.fn(async (sessionId: string) => ({
    sessionId,
    reason: "completed" as const,
    released: true,
    skipReason: undefined as string | undefined,
    errors: [] as string[],
  })),
);

vi.mock("../specialist-prompts", () => ({
  getSpecialistByRole: specialistByRoleMock,
  getSpecialistById: specialistByIdMock,
  buildDelegationPrompt: buildDelegationPromptMock,
}));

vi.mock("../delegation-depth", () => ({
  checkDelegationDepth: checkDelegationDepthMock,
  calculateChildDepth: calculateChildDepthMock,
  buildAgentMetadata: buildAgentMetadataMock,
}));

vi.mock("uuid", () => ({
  v4: uuidMock,
}));

vi.mock("@/core/acp/http-session-store", () => ({
  getHttpSessionStore: () => ({
    getSession: getSessionMock,
    hydrateFromDb: hydrateFromDbMock,
    listSessions: listSessionsMock,
  }),
}));

vi.mock("@/core/storage/agent-memory-writer", () => ({
  AgentMemoryWriter: AgentMemoryWriterMock,
}));

vi.mock("@/core/acp/session-db-persister", () => ({
  appendSessionNotificationEventOnce: appendSessionNotificationEventOnceMock,
  loadHistorySinceEventIdFromDb: loadHistorySinceEventIdFromDbMock,
}));

vi.mock("@/core/acp/session-runtime-finalizer", () => ({
  finalizeSessionRuntime: finalizeSessionRuntimeMock,
}));

const { RoutaOrchestrator } = await import("../orchestrator");

function createSystemFixture() {
  const task = createTask({
    id: "task-1",
    title: "Frontend polish task",
    objective: "Improve the frontend experience",
    scope: "Touch the dashboard UI only",
    acceptanceCriteria: ["renders updated layout"],
    verificationCommands: ["npm run test"],
    testCases: ["layout renders correctly"],
    workspaceId: "ws-1",
    sessionId: "creator-session",
    position: 0,
    labels: [],
  });

  const eventBus = {
    on: vi.fn(),
    emit: vi.fn(),
  };

  const taskStore = {
    get: vi.fn(async (taskId: string) => (taskId === task.id ? task : undefined)),
    save: vi.fn(async () => {}),
  };

  const callerAgent = createAgent({
    id: "caller-agent",
    name: "Lead",
    role: AgentRole.ROUTA,
    workspaceId: "ws-1",
    modelTier: ModelTier.SMART,
    metadata: {},
  });

  const existingRosterAgent = createAgent({
    id: "existing-team-agent",
    name: "Existing Frontend Dev",
    role: AgentRole.CRAFTER,
    workspaceId: "ws-1",
    modelTier: ModelTier.BALANCED,
    metadata: {
      rosterRoleId: "team-frontend-dev",
      displayLabel: "Lee",
    },
  });

  const childAgent = createAgent({
    id: "child-agent-1",
    name: "crafter-frontend-polish-task",
    role: AgentRole.CRAFTER,
    workspaceId: "ws-1",
    modelTier: ModelTier.BALANCED,
    metadata: { specialist: "crafter" },
  });
  childAgent.status = AgentStatus.ACTIVE;

  const winnerAgent = createAgent({
    id: "winner-agent",
    name: "crafter-winner",
    role: AgentRole.CRAFTER,
    workspaceId: "ws-1",
    modelTier: ModelTier.BALANCED,
    metadata: { specialist: "crafter" },
  });
  winnerAgent.status = AgentStatus.ACTIVE;

  const agentStore = {
    get: vi.fn(async (agentId: string) => {
      if (agentId === "caller-agent") {
        return callerAgent;
      }
      if (agentId === "existing-team-agent") {
        return existingRosterAgent;
      }
      if (agentId === "child-agent-1") {
        return childAgent;
      }
      if (agentId === "winner-agent") {
        return winnerAgent;
      }
      return undefined;
    }),
    listByWorkspace: vi.fn(async () => [existingRosterAgent]),
    updateStatus: vi.fn(async () => {}),
  };

  const system = {
    eventBus,
    taskStore,
    agentStore,
    conversationStore: {},
    tools: {
      createAgent: vi.fn(async () => ({
        success: true,
        data: { agentId: "child-agent-1" },
      })),
      reportToParent: vi.fn(async () => ({ success: true })),
    },
  };

  const processManager = {
    killSession: vi.fn(),
  };

  return {
    task,
    callerAgent,
    existingRosterAgent,
    childAgent,
    winnerAgent,
    system,
    processManager,
  };
}

function createOrchestratorFixture() {
  const fixture = createSystemFixture();
  const orchestrator = new RoutaOrchestrator(
    fixture.system as never,
    fixture.processManager as never,
    {
      defaultCrafterProvider: "claude",
      defaultGateProvider: "opencode",
      defaultCwd: "/workspace/project",
      serverPort: "3333",
    },
  );

  return { ...fixture, orchestrator };
}

/**
 * Stub the two-phase child runtime (session creation + prompt dispatch) so
 * delegation tests do not touch real provider adapters.
 */
function stubChildSessionRuntime(
  orchestrator: InstanceType<typeof RoutaOrchestrator>,
  impl?: {
    create?: () => Promise<{ sandboxId?: string; acpSessionId: string }>;
    dispatch?: () => Promise<void>;
  },
) {
  const createChildAgentSession = vi.fn(
    impl?.create ?? (async () => ({ sandboxId: "sandbox-1", acpSessionId: "acp-session-1" })),
  );
  const dispatchChildInitialPrompt = vi.fn(impl?.dispatch ?? (async () => {}));
  (
    orchestrator as unknown as { createChildAgentSession: typeof createChildAgentSession }
  ).createChildAgentSession = createChildAgentSession;
  (
    orchestrator as unknown as { dispatchChildInitialPrompt: typeof dispatchChildInitialPrompt }
  ).dispatchChildInitialPrompt = dispatchChildInitialPrompt;
  return { createChildAgentSession, dispatchChildInitialPrompt };
}

describe("RoutaOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // mockReset (not just clear): the mockReturnValueOnce queue must not leak
    // unconsumed values into the next test.
    uuidMock.mockReset();
    getSessionMock.mockReset();
    getSessionMock.mockReturnValue(undefined);
    AgentMemoryWriterMock.mockClear();
    recordDelegationMock.mockClear();
    recordChildSessionStartMock.mockClear();
    recordChildCompletionMock.mockClear();
    uuidMock
      .mockReturnValueOnce("session-uuid-1")
      .mockReturnValueOnce("group-uuid-1");
    checkDelegationDepthMock.mockResolvedValue({
      allowed: true,
      currentDepth: 1,
    });
    specialistByRoleMock.mockImplementation((role: AgentRole) => {
      if (role === AgentRole.CRAFTER) {
        return {
          id: "crafter",
          name: "Crafter",
          role: AgentRole.CRAFTER,
          defaultModelTier: ModelTier.BALANCED,
        };
      }
      if (role === AgentRole.GATE) {
        return {
          id: "gate",
          name: "Gate",
          role: AgentRole.GATE,
          defaultModelTier: ModelTier.SMART,
        };
      }
      return undefined;
    });
    specialistByIdMock.mockImplementation((id: string) => {
      if (id === "crafter") {
        return {
          id: "crafter",
          name: "Crafter",
          role: AgentRole.CRAFTER,
          defaultModelTier: ModelTier.BALANCED,
        };
      }
      if (id === "gate") {
        return {
          id: "gate",
          name: "Gate",
          role: AgentRole.GATE,
          defaultModelTier: ModelTier.SMART,
        };
      }
      return undefined;
    });
    buildAgentMetadataMock.mockImplementation(
      (
        depth: number,
        callerAgentId?: string,
        specialistId?: string,
        runtimeMetadata?: Record<string, string>,
      ) => ({
        delegationDepth: String(depth),
        createdByAgentId: callerAgentId ?? "",
        specialist: specialistId ?? "",
        ...runtimeMetadata,
      }),
    );
  });

  it("returns an error for unknown specialists", async () => {
    const { orchestrator } = createOrchestratorFixture();

    const result = await orchestrator.delegateTaskWithSpawn({
      taskId: "task-1",
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: "ws-1",
      specialist: "unknown-specialist",
    });

    expect(result).toEqual({
      success: false,
      error:
        'Unknown specialist: unknown-specialist. Use "CRAFTER", "GATE", "crafter", or "gate".',
    });
  });

  it("returns a task-name hint when the task id is not a UUID", async () => {
    const { orchestrator } = createOrchestratorFixture();

    const result = await orchestrator.delegateTaskWithSpawn({
      taskId: "frontend cleanup",
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: "ws-1",
      specialist: "crafter",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('The taskId "frontend cleanup" looks like a task name');
    expect(result.error).toContain("First call create_task");
  });

  it("returns an error when loading the delegated task fails", async () => {
    const { orchestrator, system, task } = createOrchestratorFixture();
    (system.taskStore.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("store exploded"));

    const result = await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    expect(result).toEqual({
      success: false,
      error: `Failed to load task ${task.id}: store exploded`,
    });
    expect(system.tools.createAgent).not.toHaveBeenCalled();
  });

  it("writes delegation memory under the caller session cwd when the child runs elsewhere", async () => {
    const { orchestrator, task } = createOrchestratorFixture();
    getSessionMock.mockImplementation((sessionId: string) =>
      sessionId === "caller-session" ? { cwd: "/workspace/parent-repo" } : undefined,
    );
    stubChildSessionRuntime(orchestrator);

    const result = await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
      cwd: "/workspace/child-repo",
    });

    expect(result.success).toBe(true);
    expect(AgentMemoryWriterMock).toHaveBeenCalledWith("/workspace/parent-repo");
    expect(AgentMemoryWriterMock).toHaveBeenCalledWith("/workspace/child-repo");
    expect(recordDelegationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "caller-session",
        taskId: task.id,
      }),
    );
    expect(recordChildSessionStartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-uuid-1",
        taskId: task.id,
      }),
    );
  });

  it("inherits the parent session cwd instead of a stale orchestrator default", async () => {
    const { orchestrator, task } = createOrchestratorFixture();
    getSessionMock.mockImplementation((sessionId: string) =>
      sessionId === "caller-session" ? { cwd: "/workspace/selected-repo" } : undefined,
    );
    const { createChildAgentSession } = stubChildSessionRuntime(orchestrator);

    const result = await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    expect(result.success).toBe(true);
    expect(createChildAgentSession).toHaveBeenCalledWith(
      expect.any(String),
      "child-agent-1",
      "claude",
      "/workspace/selected-repo",
      "caller-session",
      "ws-1",
    );
  });

  it("skips parent delegation memory when the caller session is unknown", async () => {
    const { orchestrator, task } = createOrchestratorFixture();
    stubChildSessionRuntime(orchestrator);

    const result = await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "unknown",
      workspaceId: task.workspaceId,
      specialist: "crafter",
      cwd: "/workspace/child-repo",
    });

    expect(result.success).toBe(true);
    expect(AgentMemoryWriterMock).toHaveBeenCalledTimes(1);
    expect(AgentMemoryWriterMock).toHaveBeenCalledWith("/workspace/child-repo");
    expect(recordDelegationMock).not.toHaveBeenCalled();
    expect(recordChildSessionStartMock).toHaveBeenCalledTimes(1);
  });

  it("creates after_all delegation groups and assigns roster metadata for team leads", async () => {
    const { orchestrator, system, callerAgent, task } = createOrchestratorFixture();
    callerAgent.metadata.specialist = "team-agent-lead";
    stubChildSessionRuntime(orchestrator);
    const sessionRegistrationHandler = vi.fn();
    orchestrator.setSessionRegistrationHandler(sessionRegistrationHandler);

    const result = await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: callerAgent.id,
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
      additionalInstructions: "Focus on frontend React polish",
      waitMode: "after_all",
    });

    expect(result.success).toBe(true);
    expect(system.tools.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        role: AgentRole.CRAFTER,
        workspaceId: "ws-1",
        parentId: "caller-agent",
        metadata: expect.objectContaining({
          delegationDepth: "2",
          createdByAgentId: "caller-agent",
          specialist: "crafter",
          rosterRoleId: "team-frontend-dev",
          displayLabel: "Taylor",
        }),
      }),
    );
    expect(system.taskStore.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: task.id,
        status: TaskStatus.IN_PROGRESS,
        assignedTo: "child-agent-1",
        sessionIds: ["session-uuid-1"],
      }),
    );
    expect(system.agentStore.updateStatus).toHaveBeenCalledWith(
      "child-agent-1",
      AgentStatus.ACTIVE,
    );
    expect(sessionRegistrationHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sandbox-1",
        parentSessionId: "caller-session",
      }),
    );
    expect(orchestrator.getSessionForAgent("child-agent-1")).toEqual(expect.any(String));
    expect(orchestrator.getChildAgents("caller-agent")).toEqual([
      expect.objectContaining({
        agentId: "child-agent-1",
        parentAgentId: "caller-agent",
        parentSessionId: "caller-session",
        taskId: task.id,
        provider: "claude",
      }),
    ]);
    expect(
      (orchestrator as unknown as { activeGroupByAgent: Map<string, string> }).activeGroupByAgent.get(
        "caller-agent",
      ),
    ).toMatch(/^delegation-group-/);
  });

  it("deduplicates concurrent completion finalization for the same child", async () => {
    const { orchestrator, task } = createOrchestratorFixture();
    stubChildSessionRuntime(orchestrator);
    const sendPromptToSessionMock = vi.fn(async () => {});
    (orchestrator as unknown as { sendPromptToSession: typeof sendPromptToSessionMock }).sendPromptToSession =
      sendPromptToSessionMock;

    await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    recordChildCompletionMock.mockClear();
    const record = orchestrator.getChildAgents("caller-agent")[0];

    await Promise.all([
      (
        orchestrator as unknown as {
          finalizeChildCompletion: (
            childAgentId: string,
            record: unknown,
            source: "reported",
          ) => Promise<void>;
        }
      ).finalizeChildCompletion("child-agent-1", record, "reported"),
      (
        orchestrator as unknown as {
          finalizeChildCompletion: (
            childAgentId: string,
            record: unknown,
            source: "reported",
          ) => Promise<void>;
        }
      ).finalizeChildCompletion("child-agent-1", record, "reported"),
    ]);

    expect(recordChildCompletionMock).toHaveBeenCalledTimes(1);
    expect(sendPromptToSessionMock).toHaveBeenCalledTimes(1);
  });

  it("serializes overlapping completion memory writes for the same child", async () => {
    const { orchestrator, task } = createOrchestratorFixture();
    stubChildSessionRuntime(orchestrator);

    await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    task.status = TaskStatus.COMPLETED;
    recordChildCompletionMock.mockClear();

    let releaseWrite: (() => void) | undefined;
    recordChildCompletionMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseWrite = resolve;
      }),
    );

    const record = orchestrator.getChildAgents("caller-agent")[0];
    const firstWrite = (
      orchestrator as unknown as {
        recordChildCompletionMemory: (
          childAgentId: string,
          record: unknown,
          source: "session_end",
        ) => Promise<void>;
      }
    ).recordChildCompletionMemory("child-agent-1", record, "session_end");

    await vi.waitFor(() => {
      expect(recordChildCompletionMock).toHaveBeenCalledTimes(1);
    });

    const secondWrite = (
      orchestrator as unknown as {
        recordChildCompletionMemory: (
          childAgentId: string,
          record: unknown,
          source: "session_end",
        ) => Promise<void>;
      }
    ).recordChildCompletionMemory("child-agent-1", record, "session_end");

    await Promise.resolve();
    expect(recordChildCompletionMock).toHaveBeenCalledTimes(1);

    releaseWrite?.();
    await Promise.all([firstWrite, secondWrite]);

    expect(recordChildCompletionMock).toHaveBeenCalledTimes(1);
  });

  it("updates completion memory when a later reported snapshot adds completion details", async () => {
    const { orchestrator, task } = createOrchestratorFixture();
    stubChildSessionRuntime(orchestrator);
    const sendPromptToSessionMock = vi.fn(async () => {});
    (orchestrator as unknown as { sendPromptToSession: typeof sendPromptToSessionMock }).sendPromptToSession =
      sendPromptToSessionMock;

    await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "gate",
    });

    task.status = TaskStatus.COMPLETED;
    recordChildCompletionMock.mockClear();
    const record = orchestrator.getChildAgents("caller-agent")[0];

    await expect(
      (
        orchestrator as unknown as {
          finalizeChildCompletion: (
            childAgentId: string,
            record: unknown,
            source: "session_end",
          ) => Promise<void>;
        }
      ).finalizeChildCompletion("child-agent-1", record, "session_end"),
    ).resolves.toBeUndefined();

    task.completionSummary = "Implemented and verified";
    task.verificationVerdict = VerificationVerdict.APPROVED;
    task.verificationReport = "Smoke checks passed";

    await expect(
      (
        orchestrator as unknown as {
          finalizeChildCompletion: (
            childAgentId: string,
            record: unknown,
            source: "reported",
          ) => Promise<void>;
        }
      ).finalizeChildCompletion("child-agent-1", record, "reported"),
    ).resolves.toBeUndefined();

    expect(recordChildCompletionMock).toHaveBeenCalledTimes(2);
    expect(recordChildCompletionMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        snapshotSource: "session_end",
        status: TaskStatus.COMPLETED,
      }),
    );
    expect(recordChildCompletionMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        snapshotSource: "reported",
        status: TaskStatus.COMPLETED,
        summary: "Implemented and verified",
        verificationVerdict: VerificationVerdict.APPROVED,
        verificationReport: "Smoke checks passed",
      }),
    );
    expect(sendPromptToSessionMock).toHaveBeenCalledTimes(1);
  });

  it("retries waking the parent on session-end fallback without rewriting completion memory", async () => {
    const { orchestrator, task } = createOrchestratorFixture();
    stubChildSessionRuntime(orchestrator);
    const sendPromptToSessionMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("wake exploded"))
      .mockResolvedValueOnce(undefined);
    (orchestrator as unknown as { sendPromptToSession: typeof sendPromptToSessionMock }).sendPromptToSession =
      sendPromptToSessionMock;

    await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    recordChildCompletionMock.mockClear();
    const record = orchestrator.getChildAgents("caller-agent")[0];

    await expect(
      (
        orchestrator as unknown as {
          finalizeChildCompletion: (
            childAgentId: string,
            record: unknown,
            source: "reported",
          ) => Promise<void>;
        }
      ).finalizeChildCompletion("child-agent-1", record, "reported"),
    ).rejects.toThrow("wake exploded");

    vi.useFakeTimers();
    try {
      const completionPromise = (
        orchestrator as unknown as {
          scheduleSessionEndCompletion: (
            childAgentId: string,
            record: unknown,
          ) => Promise<void>;
        }
      ).scheduleSessionEndCompletion("child-agent-1", record);

      await vi.advanceTimersByTimeAsync(500);
      await expect(completionPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    expect(recordChildCompletionMock).toHaveBeenCalledTimes(1);
    expect(sendPromptToSessionMock).toHaveBeenCalledTimes(2);
  });

  it("still skips session-end finalization after a successful completion", async () => {
    const { orchestrator, task } = createOrchestratorFixture();
    stubChildSessionRuntime(orchestrator);
    const sendPromptToSessionMock = vi.fn(async () => {});
    (orchestrator as unknown as { sendPromptToSession: typeof sendPromptToSessionMock }).sendPromptToSession =
      sendPromptToSessionMock;

    await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    recordChildCompletionMock.mockClear();
    vi.useFakeTimers();
    try {
      const record = orchestrator.getChildAgents("caller-agent")[0];
      await expect(
        (
          orchestrator as unknown as {
            finalizeChildCompletion: (
              childAgentId: string,
              record: unknown,
              source: "reported",
            ) => Promise<void>;
          }
        ).finalizeChildCompletion("child-agent-1", record, "reported"),
      ).resolves.toBeUndefined();

      recordChildCompletionMock.mockClear();
      sendPromptToSessionMock.mockClear();

      const completionPromise = (
        orchestrator as unknown as {
          scheduleSessionEndCompletion: (
            childAgentId: string,
            record: unknown,
          ) => Promise<void>;
        }
      ).scheduleSessionEndCompletion("child-agent-1", record);

      await vi.advanceTimersByTimeAsync(500);
      await expect(completionPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    expect(recordChildCompletionMock).not.toHaveBeenCalled();
    expect(sendPromptToSessionMock).not.toHaveBeenCalled();
  });

  it("keeps completion handling non-blocking when the task snapshot lookup fails", async () => {
    const { orchestrator, system, task } = createOrchestratorFixture();
    stubChildSessionRuntime(orchestrator);
    const sendPromptToSessionMock = vi.fn(async () => {});
    (orchestrator as unknown as { sendPromptToSession: typeof sendPromptToSessionMock }).sendPromptToSession =
      sendPromptToSessionMock;

    await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    recordChildCompletionMock.mockClear();
    (system.taskStore.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("store exploded"));
    const record = orchestrator.getChildAgents("caller-agent")[0];

    await expect(
      (
        orchestrator as unknown as {
          finalizeChildCompletion: (
            childAgentId: string,
            record: unknown,
            source: "session_end",
          ) => Promise<void>;
        }
      ).finalizeChildCompletion("child-agent-1", record, "session_end"),
    ).resolves.toBeUndefined();

    expect(recordChildCompletionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskTitle: task.id,
        status: "unknown",
        snapshotSource: "session_end",
      }),
    );
    expect(sendPromptToSessionMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the task unchanged when creating the child session fails before binding", async () => {
    const { orchestrator, system, task } = createOrchestratorFixture();
    stubChildSessionRuntime(orchestrator, {
      create: async () => {
        throw new Error("spawn exploded");
      },
    });

    const result = await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    expect(result).toEqual({
      success: false,
      error: "Failed to spawn agent process: spawn exploded",
    });
    // The binding was never persisted: the task keeps its previous state and
    // only the fresh agent is marked ERROR (never activated first).
    expect(system.agentStore.updateStatus).toHaveBeenCalledTimes(1);
    expect(system.agentStore.updateStatus).toHaveBeenCalledWith(
      "child-agent-1",
      AgentStatus.ERROR,
    );
    expect(system.taskStore.save).not.toHaveBeenCalled();
    expect(task.status).toBe(TaskStatus.PENDING);
  });

  it("delivers completion reports with a deterministic team-report deliveryId", async () => {
    const { orchestrator, task } = createOrchestratorFixture();
    stubChildSessionRuntime(orchestrator);
    const sendPromptToSessionMock = vi.fn(async () => {});
    (orchestrator as unknown as { sendPromptToSession: typeof sendPromptToSessionMock }).sendPromptToSession =
      sendPromptToSessionMock;

    await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    const record = orchestrator.getChildAgents("caller-agent")[0];
    await (
      orchestrator as unknown as {
        finalizeChildCompletion: (childAgentId: string, record: unknown, source: "reported") => Promise<void>;
      }
    ).finalizeChildCompletion("child-agent-1", record, "reported");

    // The wake goes through the recover-aware dispatch with a deterministic
    // deliveryId built from durable IDs only (never provider session IDs).
    expect(sendPromptToSessionMock).toHaveBeenCalledWith(
      "caller-session",
      expect.stringContaining("Agent Completion Report"),
      `team-report:caller-session:${record.sessionId}:${task.id}:0`,
    );

    // After provider acceptance, the durable `:delivered` receipt is appended.
    expect(appendSessionNotificationEventOnceMock).toHaveBeenCalledWith(
      "caller-session",
      expect.objectContaining({
        eventId: `team-report:caller-session:${record.sessionId}:${task.id}:0:delivered`,
        update: expect.objectContaining({ sessionUpdate: "delivery_receipt" }),
      }),
    );

    // Durable report acceptance triggers the completed-child release through
    // the shared runtime finalizer (which re-checks every safety gate).
    expect(finalizeSessionRuntimeMock).toHaveBeenCalledWith(record.sessionId, "completed");
  });

  it("increments the report revision from previously delivered receipts", async () => {
    const { orchestrator, task } = createOrchestratorFixture();
    stubChildSessionRuntime(orchestrator);
    const sendPromptToSessionMock = vi.fn(async () => {});
    (orchestrator as unknown as { sendPromptToSession: typeof sendPromptToSessionMock }).sendPromptToSession =
      sendPromptToSessionMock;

    await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    const record = orchestrator.getChildAgents("caller-agent")[0];
    // A previous report for the same triple was already delivered.
    loadHistorySinceEventIdFromDbMock.mockResolvedValueOnce([
      { eventId: `team-report:caller-session:${record.sessionId}:${task.id}:0:delivered` },
    ]);

    await (
      orchestrator as unknown as {
        finalizeChildCompletion: (childAgentId: string, record: unknown, source: "reported") => Promise<void>;
      }
    ).finalizeChildCompletion("child-agent-1", record, "reported");

    expect(sendPromptToSessionMock).toHaveBeenCalledWith(
      "caller-session",
      expect.any(String),
      `team-report:caller-session:${record.sessionId}:${task.id}:1`,
    );
  });

  it("keeps the delivery retryable (no receipt) when the wake dispatch fails", async () => {
    const { orchestrator, task } = createOrchestratorFixture();
    stubChildSessionRuntime(orchestrator);
    const sendPromptToSessionMock = vi.fn().mockRejectedValueOnce(new Error("runtime unavailable"));
    (orchestrator as unknown as { sendPromptToSession: typeof sendPromptToSessionMock }).sendPromptToSession =
      sendPromptToSessionMock;

    await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    const record = orchestrator.getChildAgents("caller-agent")[0];
    await expect(
      (
        orchestrator as unknown as {
          finalizeChildCompletion: (childAgentId: string, record: unknown, source: "reported") => Promise<void>;
        }
      ).finalizeChildCompletion("child-agent-1", record, "reported"),
    ).rejects.toThrow("runtime unavailable");

    // No receipt: the recorded delivery stays re-dispatchable on retry.
    expect(appendSessionNotificationEventOnceMock).not.toHaveBeenCalled();
    // Without durable acceptance there is no completed-child release attempt.
    expect(finalizeSessionRuntimeMock).not.toHaveBeenCalled();
  });

  it("keeps the wake successful when the completed-child release is skipped or fails", async () => {
    const { orchestrator, task } = createOrchestratorFixture();
    stubChildSessionRuntime(orchestrator);
    const sendPromptToSessionMock = vi.fn(async () => {});
    (orchestrator as unknown as { sendPromptToSession: typeof sendPromptToSessionMock }).sendPromptToSession =
      sendPromptToSessionMock;
    // First completion: the finalizer skips the release (gate not satisfied).
    finalizeSessionRuntimeMock.mockResolvedValueOnce({
      sessionId: "child-session",
      reason: "completed",
      released: false,
      skipReason: "report-not-delivered",
      errors: [],
    });

    await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    const record = orchestrator.getChildAgents("caller-agent")[0];
    await expect(
      (
        orchestrator as unknown as {
          finalizeChildCompletion: (childAgentId: string, record: unknown, source: "reported") => Promise<void>;
        }
      ).finalizeChildCompletion("child-agent-1", record, "reported"),
    ).resolves.toBeUndefined();

    const deliveryId = `team-report:caller-session:${record.sessionId}:${task.id}:0`;
    expect(sendPromptToSessionMock).toHaveBeenCalledWith(
      "caller-session",
      expect.any(String),
      deliveryId,
    );
    expect(appendSessionNotificationEventOnceMock).toHaveBeenCalledWith(
      "caller-session",
      expect.objectContaining({ eventId: `${deliveryId}:delivered` }),
    );
    expect(finalizeSessionRuntimeMock).toHaveBeenCalledWith(record.sessionId, "completed");

    // Second completion (retry path): the finalizer itself throws. The wake
    // must still succeed — release failures retain the session for retry.
    finalizeSessionRuntimeMock.mockRejectedValueOnce(new Error("release exploded"));
    (record as { completionHandled?: boolean }).completionHandled = false;
    await expect(
      (
        orchestrator as unknown as {
          finalizeChildCompletion: (childAgentId: string, record: unknown, source: "session_end") => Promise<void>;
        }
      ).finalizeChildCompletion("child-agent-1", record, "session_end"),
    ).resolves.toBeUndefined();
    expect(finalizeSessionRuntimeMock).toHaveBeenCalledTimes(2);
  });

  it("does not release the child runtime when the delivery receipt write fails", async () => {
    const { orchestrator, task } = createOrchestratorFixture();
    stubChildSessionRuntime(orchestrator);
    const sendPromptToSessionMock = vi.fn(async () => {});
    (orchestrator as unknown as { sendPromptToSession: typeof sendPromptToSessionMock }).sendPromptToSession =
      sendPromptToSessionMock;
    // The provider accepted the report, but the durable receipt could not be
    // written (DB unavailable). Releasing the child runtime now would destroy
    // the only retry handle for an unproven hand-off.
    appendSessionNotificationEventOnceMock.mockResolvedValueOnce({
      status: "unavailable",
      error: "database is locked",
    });

    await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    const record = orchestrator.getChildAgents("caller-agent")[0];
    await expect(
      (
        orchestrator as unknown as {
          finalizeChildCompletion: (childAgentId: string, record: unknown, source: "reported") => Promise<void>;
        }
      ).finalizeChildCompletion("child-agent-1", record, "reported"),
    ).resolves.toBeUndefined();

    // The wake itself succeeded (provider accepted the report)…
    expect(sendPromptToSessionMock).toHaveBeenCalledTimes(1);
    expect(appendSessionNotificationEventOnceMock).toHaveBeenCalledWith(
      "caller-session",
      expect.objectContaining({
        eventId: expect.stringContaining(":delivered"),
        update: expect.objectContaining({ sessionUpdate: "delivery_receipt" }),
      }),
    );
    // …but without a durable receipt the child runtime must NOT be released.
    expect(finalizeSessionRuntimeMock).not.toHaveBeenCalled();
  });

  it("returns the canonical delegation result with status delegated", async () => {
    const { orchestrator, task } = createOrchestratorFixture();
    stubChildSessionRuntime(orchestrator);

    const result = await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        taskId: task.id,
        agentId: "child-agent-1",
        sessionId: "session-uuid-1",
        specialist: "crafter",
        provider: "claude",
        status: "delegated",
      }),
    );
  });

  it("reuses an active delegation binding instead of spawning a duplicate", async () => {
    const { orchestrator, system, task } = createOrchestratorFixture();
    const { createChildAgentSession } = stubChildSessionRuntime(orchestrator);
    task.assignedTo = "winner-agent";
    task.status = TaskStatus.IN_PROGRESS;
    task.sessionIds = ["existing-child-session"];
    getSessionMock.mockImplementation((sessionId: string) =>
      sessionId === "existing-child-session"
        ? { cwd: "/workspace/selected-repo", acpStatus: "ready" }
        : sessionId === "caller-session"
          ? { cwd: "/workspace/selected-repo" }
          : undefined,
    );

    const result = await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        taskId: task.id,
        agentId: "winner-agent",
        sessionId: "existing-child-session",
        status: "delegated",
      }),
    );
    expect((result.data as { message: string }).message).toContain("already delegated");
    // No duplicate resources: no agent, session, or binding write happens.
    expect(system.tools.createAgent).not.toHaveBeenCalled();
    expect(createChildAgentSession).not.toHaveBeenCalled();
    expect(system.taskStore.save).not.toHaveBeenCalled();
  });

  it("persists the binding before activating the agent or dispatching the prompt", async () => {
    const { orchestrator, system, task } = createOrchestratorFixture();
    const { dispatchChildInitialPrompt } = stubChildSessionRuntime(orchestrator);
    const calls: string[] = [];
    (system.taskStore.save as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push("persist");
    });
    (system.agentStore.updateStatus as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push("updateStatus");
    });
    dispatchChildInitialPrompt.mockImplementation(async () => {
      calls.push("dispatch");
    });

    const result = await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    expect(result.success).toBe(true);
    expect(calls).toEqual(["persist", "updateStatus", "dispatch"]);
    expect(dispatchChildInitialPrompt).toHaveBeenCalledWith(
      "child-agent-1",
      "session-uuid-1",
      "acp-session-1",
      "claude",
      "delegation prompt",
    );
  });

  it("keeps the session for diagnostics and blocks the task when prompt dispatch fails", async () => {
    const { orchestrator, system, task } = createOrchestratorFixture();
    stubChildSessionRuntime(orchestrator, {
      dispatch: async () => {
        throw new Error("prompt exploded");
      },
    });
    const kanbanBoardStore = {
      get: vi.fn(async () => undefined),
      getDefault: vi.fn(async () => undefined),
    };
    (system as unknown as { kanbanBoardStore: typeof kanbanBoardStore }).kanbanBoardStore = kanbanBoardStore;

    const result = await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    expect(result).toEqual({
      success: false,
      error: "Failed to start agent process: prompt exploded",
    });
    // The binding was already saved: the failed session stays in sessionIds.
    expect(task.status).toBe(TaskStatus.BLOCKED);
    expect(task.sessionIds).toContain("session-uuid-1");
    expect(task.assignedTo).toBe("child-agent-1");
    expect(system.agentStore.updateStatus).toHaveBeenCalledWith(
      "child-agent-1",
      AgentStatus.ERROR,
    );
    expect(system.taskStore.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: task.id,
        status: TaskStatus.BLOCKED,
      }),
    );
  });

  it("never returns success when persisting the binding throws", async () => {
    const { orchestrator, system, task, processManager } = createOrchestratorFixture();
    stubChildSessionRuntime(orchestrator);
    (system.taskStore.save as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db locked"),
    );

    const result = await orchestrator.delegateTaskWithSpawn({
      taskId: task.id,
      callerAgentId: "caller-agent",
      callerSessionId: "caller-session",
      workspaceId: task.workspaceId,
      specialist: "crafter",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to persist delegation binding");
    expect(result.error).toContain("db locked");
    expect(system.agentStore.updateStatus).not.toHaveBeenCalledWith(
      "child-agent-1",
      AgentStatus.ACTIVE,
    );
    expect(processManager.killSession).toHaveBeenCalledWith("session-uuid-1");
  });

  it("serializes concurrent delegation attempts for the same task", async () => {
    const { orchestrator, system, task } = createOrchestratorFixture();
    const { createChildAgentSession } = stubChildSessionRuntime(orchestrator);
    getSessionMock.mockImplementation((sessionId: string) =>
      sessionId === "session-uuid-1"
        ? { cwd: "/workspace/project", acpStatus: "ready" }
        : sessionId === "caller-session"
          ? { cwd: "/workspace/project" }
          : undefined,
    );

    const [first, second] = await Promise.all([
      orchestrator.delegateTaskWithSpawn({
        taskId: task.id,
        callerAgentId: "caller-agent",
        callerSessionId: "caller-session",
        workspaceId: task.workspaceId,
        specialist: "crafter",
      }),
      orchestrator.delegateTaskWithSpawn({
        taskId: task.id,
        callerAgentId: "caller-agent",
        callerSessionId: "caller-session",
        workspaceId: task.workspaceId,
        specialist: "crafter",
      }),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    // Only one child session is created; the second attempt reuses the binding.
    expect(createChildAgentSession).toHaveBeenCalledTimes(1);
    expect(system.tools.createAgent).toHaveBeenCalledTimes(1);
    expect(second.data).toEqual(
      expect.objectContaining({
        agentId: "child-agent-1",
        sessionId: "session-uuid-1",
        status: "delegated",
      }),
    );
  });

});
