import { beforeEach, describe, expect, it, vi } from "vitest";

const managerMock = vi.hoisted(() => ({
  hasActiveSession: vi.fn(),
  getAcpSessionId: vi.fn(),
  loadSession: vi.fn(),
  createSession: vi.fn(),
  createClaudeSession: vi.fn(),
  createClaudeCodeSdkSession: vi.fn(),
  createOpencodeSdkSession: vi.fn(),
  createDockerSession: vi.fn(),
}));

const storeMock = vi.hoisted(() => ({
  getSession: vi.fn(),
  upsertSession: vi.fn(),
  setProviderSessionId: vi.fn(),
  getHistory: vi.fn(() => []),
  getConsolidatedHistory: vi.fn((): unknown[] | undefined => undefined),
  listSessions: vi.fn(() => []),
  hydrateFromDb: vi.fn(async () => {}),
}));

const getPresetByIdMock = vi.hoisted(() => vi.fn());
const isServerlessEnvironmentMock = vi.hoisted(() => vi.fn(() => false));
const loadSessionFromDbMock = vi.hoisted(() => vi.fn());
const loadSessionFromLocalStorageMock = vi.hoisted(() => vi.fn());
const persistSessionToDbMock = vi.hoisted(() => vi.fn(async () => {}));
const updateSessionRuntimeBindingInDbMock = vi.hoisted(() =>
  vi.fn(async (_sessionId: string, _update: Record<string, unknown>) => true),
);
const tryAcquireSessionLeaseInDbMock = vi.hoisted(() => vi.fn(async () => true));
// P1 fail-closed lease acquisition: the structured 5-state result that
// recovery must branch on (acquired | already_owned | conflict | missing |
// unavailable). Never a bare boolean.
const acquireSessionLeaseInDbMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{
    outcome: "acquired" | "already_owned" | "conflict" | "missing" | "unavailable";
    ownerInstanceId?: string;
    leaseExpiresAt?: string;
  }> => ({ outcome: "acquired" })),
);
// Mirror the shared capture-persistence helper: record the native ID in the
// in-memory store and persist the runtime binding. Recovery delegates to it.
const persistCapturedProviderSessionIdMock = vi.hoisted(() => vi.fn());
const getAcpInstanceIdMock = vi.hoisted(() => vi.fn(() => "instance-under-test"));
const buildAcpLeaseExpiresAtMock = vi.hoisted(() => vi.fn(() => "2026-08-11T12:05:00.000Z"));
const isExecutionLeaseActiveMock = vi.hoisted(() => vi.fn(
  (leaseExpiresAt?: string) => !!leaseExpiresAt && Date.parse(leaseExpiresAt) > Date.now(),
));
const getEmbeddedOwnershipIssueMock = vi.hoisted(() => vi.fn((): string | null => null));
const buildProviderModelArgsMock = vi.hoisted(() => vi.fn(() => [] as string[]));
const getSpecialistByIdMock = vi.hoisted(() => vi.fn(() => undefined));
const buildTeamChainPolicyPromptMock = vi.hoisted(() => vi.fn(() => null));
const recordTraceMock = vi.hoisted(() => vi.fn());
const isOpencodeServerConfiguredMock = vi.hoisted(() => vi.fn(() => true));
const isClaudeCodeSdkConfiguredMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("@/core/acp/processer", () => ({
  getAcpProcessManager: () => managerMock,
}));

vi.mock("@/core/acp/http-session-store", () => ({
  getHttpSessionStore: () => storeMock,
}));

vi.mock("@/core/acp/acp-presets", () => ({
  getPresetById: getPresetByIdMock,
}));

vi.mock("@/core/acp/api-based-providers", () => ({
  isServerlessEnvironment: isServerlessEnvironmentMock,
}));

vi.mock("@/core/acp/session-db-persister", () => ({
  loadSessionFromDb: loadSessionFromDbMock,
  loadSessionFromLocalStorage: loadSessionFromLocalStorageMock,
  persistSessionToDb: persistSessionToDbMock,
  updateSessionRuntimeBindingInDb: updateSessionRuntimeBindingInDbMock,
  tryAcquireSessionLeaseInDb: tryAcquireSessionLeaseInDbMock,
  acquireSessionLeaseInDb: acquireSessionLeaseInDbMock,
  persistCapturedProviderSessionId: persistCapturedProviderSessionIdMock,
}));

vi.mock("@/core/acp/execution-backend", () => ({
  buildAcpLeaseExpiresAt: buildAcpLeaseExpiresAtMock,
  getAcpInstanceId: getAcpInstanceIdMock,
  getEmbeddedOwnershipIssue: getEmbeddedOwnershipIssueMock,
  isExecutionLeaseActive: isExecutionLeaseActiveMock,
}));

vi.mock("@/core/acp/provider-model-args", () => ({
  buildProviderModelArgs: buildProviderModelArgsMock,
}));

vi.mock("@/core/orchestration/specialist-prompts", () => ({
  getSpecialistById: getSpecialistByIdMock,
}));

vi.mock("@/core/orchestration/team-run-identity", () => ({
  TEAM_LEAD_SPECIALIST_ID: "team-agent-lead",
}));

vi.mock("@/core/orchestration/team-chain", () => ({
  buildTeamChainPolicyPrompt: buildTeamChainPolicyPromptMock,
}));

vi.mock("@/core/trace", () => ({
  createTraceRecord: vi.fn((sessionId: string, type: string, metadata: unknown) => ({
    sessionId,
    type,
    metadata,
  })),
  withWorkspaceId: vi.fn((record: Record<string, unknown>) => record),
  withMetadata: vi.fn((record: Record<string, unknown>) => record),
  recordTrace: recordTraceMock,
}));

vi.mock("@/core/acp/opencode-sdk-adapter", () => ({
  isOpencodeServerConfigured: isOpencodeServerConfiguredMock,
}));

vi.mock("@/core/acp/claude-code-sdk-adapter", () => ({
  isClaudeCodeSdkConfigured: isClaudeCodeSdkConfiguredMock,
}));

// The recovery envelope builder is exercised through its real pure render
// function; the durable collectors and the pending-prefix queue are mocked so
// these tests control exactly which envelope recovery sees.
const collectRecoveryEnvelopeMock = vi.hoisted(() => vi.fn(async (): Promise<unknown> => undefined));
const setPendingRecoveryContextMock = vi.hoisted(() => vi.fn());

vi.mock("@/core/acp/recovery-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../recovery-context")>();
  return {
    ...actual,
    collectRecoveryEnvelope: collectRecoveryEnvelopeMock,
    setPendingRecoveryContext: setPendingRecoveryContextMock,
  };
});

// P1 all-or-nothing Team binding restoration: recovery must branch on the
// structured result — a ROUTA session whose bindings cannot be fully restored
// must fail recovery instead of starting a chat-only runtime.
const restoreTeamRuntimeBindingsMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{
    restored: boolean;
    failure?: {
      code: "missing_team_metadata" | "team_bindings_incomplete";
      message: string;
      missingMetadata?: string[];
      missingBindings?: string[];
      unmappedSessionIds?: string[];
    };
    mcpProfile?: "team-coordination";
    restoredSessions: number;
    restoredChildRecords: number;
  }> => ({
    restored: true,
    mcpProfile: "team-coordination",
    restoredSessions: 1,
    restoredChildRecords: 1,
  })),
);

vi.mock("@/core/orchestration/team-runtime-bindings", () => ({
  restoreTeamRuntimeBindings: restoreTeamRuntimeBindingsMock,
}));

const {
  ensureSessionRuntime,
  resolveProviderRecoveryStrategy,
  SessionRuntimeRecoveryError,
} = await import("../session-runtime-recovery");

const forwarder = vi.fn();

type EnsureArgs = Parameters<typeof ensureSessionRuntime>[0];

function defaultArgs(overrides: Record<string, unknown> = {}): EnsureArgs {
  return {
    sessionId: "session-1",
    workspaceId: "ws-1",
    allowFreshCreate: false,
    createSessionUpdateForwarder: () => forwarder,
    ...overrides,
  } as EnsureArgs;
}

describe("resolveProviderRecoveryStrategy", () => {
  it("uses native resume for Claude family only when a provider session ID was persisted", () => {
    const withProviderSession = resolveProviderRecoveryStrategy("claude", undefined, {
      id: "s",
      cwd: "/w",
      workspaceId: "ws-1",
      providerSessionId: "claude-native-1",
    });
    expect(withProviderSession.strategy).toBe("native_resume");

    const withoutProviderSession = resolveProviderRecoveryStrategy("claude-code-sdk", undefined, {
      id: "s",
      cwd: "/w",
      workspaceId: "ws-1",
    });
    expect(withoutProviderSession.strategy).toBe("context_rebuild");
  });

  it("gates Codex native resume on the first prompt being sent (no rollout before it)", () => {
    const base = { id: "s", cwd: "/w", workspaceId: "ws-1" };
    expect(resolveProviderRecoveryStrategy("codex", undefined, { ...base, firstPromptSent: true }).strategy)
      .toBe("native_resume");
    expect(resolveProviderRecoveryStrategy("codex", undefined, { ...base, firstPromptSent: false }).strategy)
      .toBe("context_rebuild");
    expect(resolveProviderRecoveryStrategy("codex", undefined, base).strategy)
      .toBe("context_rebuild");
  });

  it("uses preset resume capabilities for standard ACP providers with the same first-prompt gate", () => {
    const nativePreset = { id: "codex", resume: { supported: true, mode: "both" as const } };
    const replayPreset = { id: "opencode", resume: { supported: true, mode: "replay" as const } };
    const base = { id: "s", cwd: "/w", workspaceId: "ws-1", firstPromptSent: true };

    expect(resolveProviderRecoveryStrategy("codex", nativePreset as never, base).strategy).toBe("native_resume");
    expect(resolveProviderRecoveryStrategy("opencode", replayPreset as never, base).strategy).toBe("context_rebuild");
    expect(resolveProviderRecoveryStrategy("custom-provider", undefined, base).strategy).toBe("context_rebuild");
  });
});

describe("ensureSessionRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managerMock.hasActiveSession.mockReturnValue(false);
    managerMock.getAcpSessionId.mockReturnValue(undefined);
    managerMock.loadSession.mockResolvedValue("acp-loaded");
    managerMock.createSession.mockResolvedValue("acp-created");
    managerMock.createClaudeSession.mockResolvedValue("claude-created");
    managerMock.createClaudeCodeSdkSession.mockResolvedValue("claude-sdk-created");
    storeMock.getSession.mockReturnValue(undefined);
    getPresetByIdMock.mockReturnValue(null);
    isServerlessEnvironmentMock.mockReturnValue(false);
    loadSessionFromDbMock.mockResolvedValue(undefined);
    loadSessionFromLocalStorageMock.mockResolvedValue(undefined);
    getEmbeddedOwnershipIssueMock.mockReturnValue(null);
    updateSessionRuntimeBindingInDbMock.mockResolvedValue(true);
    tryAcquireSessionLeaseInDbMock.mockResolvedValue(true);
    acquireSessionLeaseInDbMock.mockResolvedValue({ outcome: "acquired" });
    // The shared capture helper records the native ID in the in-memory store
    // and persists the runtime binding (mirrors the real implementation).
    persistCapturedProviderSessionIdMock.mockImplementation(
      async (sessionId: string, captured: string) => {
        if (!captured || captured === sessionId) return;
        storeMock.setProviderSessionId(sessionId, captured);
        await updateSessionRuntimeBindingInDbMock(sessionId, { providerSessionId: captured });
      },
    );
    getAcpInstanceIdMock.mockReturnValue("instance-under-test");
    buildAcpLeaseExpiresAtMock.mockReturnValue("2026-08-11T12:05:00.000Z");
    isExecutionLeaseActiveMock.mockImplementation(
      (leaseExpiresAt?: string) => !!leaseExpiresAt && Date.parse(leaseExpiresAt) > Date.now(),
    );
    collectRecoveryEnvelopeMock.mockResolvedValue(undefined);
    restoreTeamRuntimeBindingsMock.mockResolvedValue({
      restored: true,
      mcpProfile: "team-coordination",
      restoredSessions: 1,
      restoredChildRecords: 1,
    });
  });

  it("returns session_not_found when nothing is persisted and fresh creation is not allowed", async () => {
    const error = await ensureSessionRuntime(defaultArgs()).catch((err) => err);

    expect(error).toBeInstanceOf(SessionRuntimeRecoveryError);
    expect(error.jsonRpcError.code).toBe(-32004);
    expect(error.jsonRpcError.data).toMatchObject({
      reason: "session_not_found",
      retryable: false,
    });
    expect(managerMock.createSession).not.toHaveBeenCalled();
  });

  it("attaches to a live runtime without creating a second provider runtime", async () => {
    managerMock.hasActiveSession.mockReturnValue(true);
    managerMock.getAcpSessionId.mockReturnValue("acp-live");
    storeMock.getSession.mockReturnValue({
      sessionId: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "opencode",
      routaAgentId: "routa-agent-1",
      createdAt: "2026-08-10T00:00:00.000Z",
    });

    const result = await ensureSessionRuntime(defaultArgs());

    expect(result.status).toBe("attached");
    expect(result.resumeMode).toBe("attached");
    expect(result.acpSessionId).toBe("acp-live");
    expect(managerMock.createSession).not.toHaveBeenCalled();
    expect(managerMock.loadSession).not.toHaveBeenCalled();

    const upserted = storeMock.upsertSession.mock.calls[0][0];
    expect(upserted.routaAgentId).toBe("routa-agent-1");
    expect(upserted.providerSessionId).toBe("acp-live");
  });

  it("never sends routaAgentId to the provider and preserves it across recovery writes", async () => {
    loadSessionFromDbMock.mockResolvedValue({
      id: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "codex",
      role: "CRAFTER",
      routaAgentId: "routa-agent-durable",
      providerSessionId: "codex-native-77",
      firstPromptSent: true,
    });
    managerMock.loadSession.mockResolvedValue("codex-native-77");

    const result = await ensureSessionRuntime(defaultArgs());

    expect(result.resumeMode).toBe("native");
    // loadSession arg[9] is the provider-native session ID — never the
    // durable routaAgentId and never only the Routa session ID.
    expect(managerMock.loadSession.mock.calls[0][9]).toBe("codex-native-77");
    expect(managerMock.loadSession.mock.calls[0][9]).not.toBe("routa-agent-durable");

    const upserted = storeMock.upsertSession.mock.calls[0][0];
    expect(upserted.routaAgentId).toBe("routa-agent-durable");
    expect(upserted.providerSessionId).toBe("codex-native-77");
    expect(updateSessionRuntimeBindingInDbMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ providerSessionId: "codex-native-77" }),
    );
  });

  it("falls back to exactly one bounded context rebuild when native resume fails", async () => {
    loadSessionFromDbMock.mockResolvedValue({
      id: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "codex",
      role: "CRAFTER",
      routaAgentId: "routa-agent-durable",
      providerSessionId: "codex-native-gone",
      firstPromptSent: true,
    });
    managerMock.loadSession.mockRejectedValue(new Error("rollout file missing"));
    managerMock.createSession.mockResolvedValue("codex-fresh");

    const result = await ensureSessionRuntime(defaultArgs());

    expect(result.resumeMode).toBe("recreated");
    expect(result.strategy).toBe("context_rebuild");
    expect(result.nativeResumeError).toBe("rollout file missing");
    expect(managerMock.loadSession).toHaveBeenCalledTimes(1);
    // Exactly one rebuild attempt — no retry loop.
    expect(managerMock.createSession).toHaveBeenCalledTimes(1);

    const upserted = storeMock.upsertSession.mock.calls[0][0];
    expect(upserted.routaAgentId).toBe("routa-agent-durable");
    expect(upserted.providerSessionId).toBe("codex-fresh");
  });

  it("seeds Claude native resume with the persisted provider session ID and rebuilds unseeded on failure", async () => {
    loadSessionFromDbMock.mockResolvedValue({
      id: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "claude",
      role: "CRAFTER",
      routaAgentId: "routa-agent-claude",
      providerSessionId: "claude-native-9",
      firstPromptSent: true,
    });
    managerMock.createClaudeSession
      .mockRejectedValueOnce(new Error("no such session"))
      .mockResolvedValueOnce("claude-rebuilt");

    const result = await ensureSessionRuntime(defaultArgs({
      buildMcpConfigForClaude: vi.fn(async () => []),
    }));

    expect(result.resumeMode).toBe("recreated");
    expect(result.nativeResumeError).toBe("no such session");
    expect(managerMock.createClaudeSession).toHaveBeenCalledTimes(2);
    // arg[8] is the resume seed: first the persisted provider session ID,
    // then unseeded for the bounded context rebuild. Never the routaAgentId.
    expect(managerMock.createClaudeSession.mock.calls[0][8]).toBe("claude-native-9");
    expect(managerMock.createClaudeSession.mock.calls[1][8]).toBeUndefined();

    const upserted = storeMock.upsertSession.mock.calls[0][0];
    expect(upserted.routaAgentId).toBe("routa-agent-claude");
    // The rebuild starts a fresh Claude conversation: the failed native ID is
    // cleared and no runtime handle is persisted until system/init reports a
    // new native ID.
    expect(upserted.providerSessionId).toBeUndefined();
    expect(updateSessionRuntimeBindingInDbMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ providerSessionId: null }),
    );
  });

  it("rebuilds Claude context unseeded when no provider session ID was persisted", async () => {
    storeMock.getSession.mockReturnValue({
      sessionId: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "claude",
      role: "CRAFTER",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    managerMock.createClaudeSession.mockResolvedValue("claude-fresh");

    const result = await ensureSessionRuntime(defaultArgs({
      allowFreshCreate: true,
      buildMcpConfigForClaude: vi.fn(async () => []),
    }));

    expect(result.strategy).toBe("context_rebuild");
    expect(result.resumeMode).toBe("recreated");
    expect(managerMock.createClaudeSession).toHaveBeenCalledTimes(1);
    expect(managerMock.createClaudeSession.mock.calls[0][8]).toBeUndefined();
  });

  it("persists provider session IDs captured from Claude system/init into the runtime binding", async () => {
    storeMock.getSession.mockReturnValue({
      sessionId: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "claude",
      role: "CRAFTER",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    managerMock.createClaudeSession.mockResolvedValue("session-1");

    await ensureSessionRuntime(defaultArgs({
      allowFreshCreate: true,
      buildMcpConfigForClaude: vi.fn(async () => []),
    }));

    // arg[9] is the capture hook; simulate the provider reporting its native
    // session ID (e.g. from the system/init message).
    const onSessionId = managerMock.createClaudeSession.mock.calls[0][9];
    expect(typeof onSessionId).toBe("function");
    onSessionId("claude-native-captured");

    expect(storeMock.setProviderSessionId).toHaveBeenCalledWith("session-1", "claude-native-captured");
    expect(updateSessionRuntimeBindingInDbMock).toHaveBeenCalledWith("session-1", {
      providerSessionId: "claude-native-captured",
    });
    // The captured provider session ID must never leak into routaAgentId.
    const upserted = storeMock.upsertSession.mock.calls[0][0];
    expect(upserted.routaAgentId).not.toBe("claude-native-captured");
  });

  it("returns runtime_owned when another instance holds the embedded lease", async () => {
    storeMock.getSession.mockReturnValue({
      sessionId: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "opencode",
      executionMode: "embedded",
      ownerInstanceId: "other-instance",
      leaseExpiresAt: "2026-08-12T00:00:00.000Z",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    getEmbeddedOwnershipIssueMock.mockReturnValue("Session is currently owned by instance other-instance.");

    const error = await ensureSessionRuntime(defaultArgs()).catch((err) => err);

    expect(error).toBeInstanceOf(SessionRuntimeRecoveryError);
    expect(error.jsonRpcError.code).toBe(-32010);
    expect(error.jsonRpcError.data).toMatchObject({
      reason: "runtime_owned",
      retryable: true,
      source: "app",
      sessionId: "session-1",
    });
    expect(managerMock.createSession).not.toHaveBeenCalled();
  });

  it("returns workspace_unavailable when no workspace can be resolved", async () => {
    const error = await ensureSessionRuntime(defaultArgs({
      workspaceId: undefined,
      allowFreshCreate: true,
    })).catch((err) => err);

    expect(error).toBeInstanceOf(SessionRuntimeRecoveryError);
    expect(error.jsonRpcError.code).toBe(-32013);
    expect(error.jsonRpcError.data).toMatchObject({ reason: "workspace_unavailable" });
  });

  it("falls back to a complete persistent record when the targeted binding update matches no row", async () => {
    updateSessionRuntimeBindingInDbMock.mockResolvedValue(false);
    loadSessionFromDbMock.mockResolvedValue({
      id: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "opencode",
      role: "CRAFTER",
      routaAgentId: "routa-agent-durable",
      model: "some-model",
      firstPromptSent: true,
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
    });
    getPresetByIdMock.mockReturnValue({ id: "opencode", resume: { supported: true, mode: "replay" } });
    managerMock.createSession.mockResolvedValue("acp-fresh");

    await ensureSessionRuntime(defaultArgs());

    expect(persistSessionToDbMock).toHaveBeenCalledWith(expect.objectContaining({
      id: "session-1",
      routaAgentId: "routa-agent-durable",
      providerSessionId: "acp-fresh",
      model: "some-model",
      firstPromptSent: true,
      executionMode: "embedded",
    }));
  });

  // ── Lease acquisition: fail-closed 5-state result (P1) ────────────────────
  // Recovery must branch on the structured acquisition outcome. A bare
  // boolean collapsed "conflict", "JSONL-only", and "DB outage" into one
  // `false`, and the follow-up re-read conflated "no row" with "DB error" —
  // so runtimes started during DB outages. That hole is closed here:
  // unavailable NEVER starts a runtime; conflict NEVER proceeds.

  it("acquires the runtime lease via CAS before starting the recovered runtime", async () => {
    loadSessionFromDbMock.mockResolvedValue({
      id: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "opencode",
      role: "CRAFTER",
      routaAgentId: "routa-agent-durable",
      // Expired lease of a dead instance — recovery must be able to take over.
      executionMode: "embedded",
      ownerInstanceId: "dead-instance",
      leaseExpiresAt: "2026-08-01T00:00:00.000Z",
      firstPromptSent: true,
    });
    managerMock.createSession.mockResolvedValue("acp-fresh");

    const result = await ensureSessionRuntime(defaultArgs());

    expect(result.status).toBe("recovered");
    expect(acquireSessionLeaseInDbMock).toHaveBeenCalledTimes(1);
    expect(acquireSessionLeaseInDbMock).toHaveBeenCalledWith("session-1", expect.objectContaining({
      ownerInstanceId: "instance-under-test",
      executionMode: "embedded",
    }));
    // The CAS must complete before any provider runtime is started.
    const casOrder = acquireSessionLeaseInDbMock.mock.invocationCallOrder[0];
    const createOrder = managerMock.createSession.mock.invocationCallOrder[0];
    expect(casOrder).toBeLessThan(createOrder);

    // The acquired lease values are the ones written by recovery.
    const upserted = storeMock.upsertSession.mock.calls[0][0];
    expect(upserted.ownerInstanceId).toBe("instance-under-test");
    expect(upserted.leaseExpiresAt).toBe("2026-08-11T12:05:00.000Z");
    expect(upserted.routaAgentId).toBe("routa-agent-durable");
  });

  it("returns a retryable conflict and never starts a second runtime when acquisition reports conflict", async () => {
    const futureLease = new Date(Date.now() + 600_000).toISOString();
    loadSessionFromDbMock.mockResolvedValue({
      id: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "opencode",
      executionMode: "embedded",
      ownerInstanceId: "other-instance",
      leaseExpiresAt: futureLease,
      firstPromptSent: true,
    });
    // The CAS refused and the classification query found the active foreign
    // holder — the structured result carries the holder info.
    acquireSessionLeaseInDbMock.mockResolvedValue({
      outcome: "conflict",
      ownerInstanceId: "other-instance",
      leaseExpiresAt: futureLease,
    });

    const error = await ensureSessionRuntime(defaultArgs()).catch((err) => err);

    expect(error).toBeInstanceOf(SessionRuntimeRecoveryError);
    expect(error.jsonRpcError.code).toBe(-32010);
    expect(error.jsonRpcError.data).toMatchObject({
      reason: "runtime_owned",
      retryable: true,
      ownerInstanceId: "other-instance",
      leaseExpiresAt: futureLease,
      sessionId: "session-1",
    });
    expect(managerMock.createSession).not.toHaveBeenCalled();
    expect(managerMock.loadSession).not.toHaveBeenCalled();
  });

  it("proceeds when acquisition reports missing (explicit JSONL-only determination)", async () => {
    storeMock.getSession.mockReturnValue({
      sessionId: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "opencode",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    // `missing` means a SUCCESSFUL query found no durable row — the session
    // exists only as JSONL. That is safe to proceed with; a DB failure would
    // have been reported as `unavailable` instead.
    acquireSessionLeaseInDbMock.mockResolvedValue({ outcome: "missing" });
    managerMock.createSession.mockResolvedValue("acp-fresh");

    const result = await ensureSessionRuntime(defaultArgs({ allowFreshCreate: true }));

    expect(result.status).toBe("recovered");
    expect(managerMock.createSession).toHaveBeenCalledTimes(1);
  });

  it("joins instead of conflicting when acquisition reports already_owned", async () => {
    const futureLease = new Date(Date.now() + 600_000).toISOString();
    loadSessionFromDbMock.mockResolvedValue({
      id: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "opencode",
      executionMode: "embedded",
      ownerInstanceId: "instance-under-test",
      leaseExpiresAt: futureLease,
      firstPromptSent: true,
    });
    acquireSessionLeaseInDbMock.mockResolvedValue({ outcome: "already_owned" });
    managerMock.createSession.mockResolvedValue("acp-fresh");

    const result = await ensureSessionRuntime(defaultArgs());

    expect(result.status).toBe("recovered");
    expect(managerMock.createSession).toHaveBeenCalledTimes(1);
  });

  it("never starts the runtime when lease verification is unavailable (fail-closed)", async () => {
    loadSessionFromDbMock.mockResolvedValue({
      id: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "opencode",
      role: "CRAFTER",
      firstPromptSent: true,
    });
    // A DB outage must fail CLOSED: no runtime may start while ownership
    // cannot be verified. `unavailable` must never be downgraded to the
    // "JSONL-only, safe to proceed" path.
    acquireSessionLeaseInDbMock.mockResolvedValue({ outcome: "unavailable" });

    const error = await ensureSessionRuntime(defaultArgs()).catch((err) => err);

    expect(error).toBeInstanceOf(SessionRuntimeRecoveryError);
    expect(error.jsonRpcError.code).toBe(-32011);
    expect(error.jsonRpcError.data).toMatchObject({
      reason: "recovery_unavailable",
      retryable: true,
      sessionId: "session-1",
    });
    expect(managerMock.createSession).not.toHaveBeenCalled();
    expect(managerMock.loadSession).not.toHaveBeenCalled();
  });

  // ── Team binding restoration: all-or-nothing for ROUTA sessions (P1) ─────
  // A ROUTA runtime must never be started chat-only. Recovery either restores
  // the full coordination binding set (Lead agent mapping, descendant session
  // mappings, child records, notification + child-registration handlers, Team
  // MCP profile) or fails with a structured recovery_failed error. The UI
  // keeps history and input; nothing silently degrades to a normal chat.

  const routaLeadRow = {
    id: "session-1",
    cwd: "/workspace",
    workspaceId: "ws-1",
    provider: "opencode",
    role: "ROUTA",
    specialistId: "team-agent-lead",
    routaAgentId: "routa-lead",
    firstPromptSent: true,
  };

  it("restores team bindings before starting a ROUTA runtime and carries the derived Team MCP profile", async () => {
    loadSessionFromDbMock.mockResolvedValue(routaLeadRow);
    managerMock.createSession.mockResolvedValue("acp-fresh");

    const result = await ensureSessionRuntime(defaultArgs());

    expect(result.status).toBe("recovered");
    expect(restoreTeamRuntimeBindingsMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      role: "ROUTA",
      routaAgentId: "routa-lead",
      specialistId: "team-agent-lead",
    }));
    // Bindings must be restored BEFORE any provider runtime is started.
    const restoreOrder = restoreTeamRuntimeBindingsMock.mock.invocationCallOrder[0];
    const createOrder = managerMock.createSession.mock.invocationCallOrder[0];
    expect(restoreOrder).toBeLessThan(createOrder);
    // The derived Team coordination profile reaches the runtime creation call.
    expect(managerMock.createSession.mock.calls[0]).toContain("team-coordination");
  });

  it("fails recovery instead of starting a chat-only runtime when team bindings cannot be restored", async () => {
    loadSessionFromDbMock.mockResolvedValue(routaLeadRow);
    restoreTeamRuntimeBindingsMock.mockResolvedValue({
      restored: false,
      failure: {
        code: "team_bindings_incomplete",
        message: "store offline",
        missingBindings: ["child_session_mappings"],
      },
      restoredSessions: 0,
      restoredChildRecords: 0,
    });

    const error = await ensureSessionRuntime(defaultArgs()).catch((err) => err);

    expect(error).toBeInstanceOf(SessionRuntimeRecoveryError);
    expect(error.jsonRpcError.code).toBe(-32012);
    expect(error.jsonRpcError.data).toMatchObject({
      reason: "recovery_failed",
      retryable: true,
      failure: "team_bindings_incomplete",
      sessionId: "session-1",
      source: "app",
    });
    expect(managerMock.createSession).not.toHaveBeenCalled();
    expect(managerMock.loadSession).not.toHaveBeenCalled();
  });

  it("reports missing team metadata as a non-retryable structured recovery failure", async () => {
    loadSessionFromDbMock.mockResolvedValue({ ...routaLeadRow, routaAgentId: undefined });
    restoreTeamRuntimeBindingsMock.mockResolvedValue({
      restored: false,
      failure: {
        code: "missing_team_metadata",
        message: "missing team metadata: routaAgentId",
        missingMetadata: ["routaAgentId"],
      },
      restoredSessions: 0,
      restoredChildRecords: 0,
    });

    const error = await ensureSessionRuntime(defaultArgs()).catch((err) => err);

    expect(error).toBeInstanceOf(SessionRuntimeRecoveryError);
    expect(error.jsonRpcError.code).toBe(-32012);
    expect(error.jsonRpcError.data).toMatchObject({
      reason: "recovery_failed",
      retryable: false,
      failure: "missing_team_metadata",
      missingMetadata: ["routaAgentId"],
      sessionId: "session-1",
    });
    expect(managerMock.createSession).not.toHaveBeenCalled();
    expect(managerMock.loadSession).not.toHaveBeenCalled();
  });

  it("does not run team binding restoration for non-ROUTA sessions", async () => {
    loadSessionFromDbMock.mockResolvedValue({
      ...routaLeadRow,
      role: "CRAFTER",
      specialistId: undefined,
      routaAgentId: "routa-agent-1",
    });
    managerMock.createSession.mockResolvedValue("acp-fresh");

    const result = await ensureSessionRuntime(defaultArgs());

    expect(result.status).toBe("recovered");
    expect(restoreTeamRuntimeBindingsMock).not.toHaveBeenCalled();
  });

  it("still attaches to a live ROUTA runtime when the binding refresh fails", async () => {
    // An attached runtime's bindings were installed when the live runtime was
    // created in this process; a failed refresh must not take it down. The
    // all-or-nothing rule guards runtime START, not attach.
    managerMock.hasActiveSession.mockReturnValue(true);
    managerMock.getAcpSessionId.mockReturnValue("acp-live");
    storeMock.getSession.mockReturnValue({
      sessionId: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "opencode",
      role: "ROUTA",
      routaAgentId: "routa-lead",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    restoreTeamRuntimeBindingsMock.mockResolvedValue({
      restored: false,
      failure: { code: "team_bindings_incomplete", message: "transient db blip" },
      restoredSessions: 0,
      restoredChildRecords: 0,
    });

    const result = await ensureSessionRuntime(defaultArgs());

    expect(result.status).toBe("attached");
    expect(managerMock.createSession).not.toHaveBeenCalled();
  });

  it("runs at most one in-flight recovery per session; concurrent callers join it", async () => {
    loadSessionFromDbMock.mockResolvedValue({
      id: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "opencode",
      firstPromptSent: true,
    });
    let releaseCreate!: (value: string) => void;
    managerMock.createSession.mockReturnValue(new Promise<string>((resolve) => {
      releaseCreate = resolve;
    }));

    const first = ensureSessionRuntime(defaultArgs());
    const second = ensureSessionRuntime(defaultArgs());

    releaseCreate("acp-fresh");
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // Exactly one provider runtime is started; both callers get the result.
    expect(managerMock.createSession).toHaveBeenCalledTimes(1);
    expect(firstResult.acpSessionId).toBe("acp-fresh");
    expect(secondResult.acpSessionId).toBe("acp-fresh");
  });

  it("refreshes the lease of this instance when attaching to a live runtime", async () => {
    managerMock.hasActiveSession.mockReturnValue(true);
    managerMock.getAcpSessionId.mockReturnValue("acp-live");
    storeMock.getSession.mockReturnValue({
      sessionId: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "opencode",
      routaAgentId: "routa-agent-1",
      createdAt: "2026-08-10T00:00:00.000Z",
    });

    const result = await ensureSessionRuntime(defaultArgs());

    expect(result.status).toBe("attached");
    expect(tryAcquireSessionLeaseInDbMock).toHaveBeenCalledWith("session-1", expect.objectContaining({
      ownerInstanceId: "instance-under-test",
      leaseExpiresAt: "2026-08-11T12:05:00.000Z",
      executionMode: "embedded",
    }));
  });

  // ── Claude provider session ID provenance (P0) ──────────────────────────
  // The Claude CLI createClaudeSession returns the ROUTA Session ID (the CLI
  // has no session/new step); the SDK adapter returns a synthetic runtime
  // handle. Neither is a provider-native resume ID. `provider_session_id`
  // must only ever hold the ID the provider itself reports (Claude
  // system/init capture hook), never these runtime handles.

  it("does not persist the Routa Session ID returned by createClaudeSession as providerSessionId", async () => {
    storeMock.getSession.mockReturnValue({
      sessionId: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "claude",
      role: "CRAFTER",
      routaAgentId: "routa-agent-claude",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    // Real manager behavior: createClaudeSession resolves with the Routa
    // Session ID because the Claude CLI has no separate session/new step.
    managerMock.createClaudeSession.mockResolvedValue("session-1");

    await ensureSessionRuntime(defaultArgs({
      allowFreshCreate: true,
      buildMcpConfigForClaude: vi.fn(async () => []),
    }));

    const upserted = storeMock.upsertSession.mock.calls[0][0];
    expect(upserted.routaAgentId).toBe("routa-agent-claude");
    // The Routa Session ID must NOT land in providerSessionId; a fresh Claude
    // conversation has no native ID until system/init reports one.
    expect(upserted.providerSessionId).toBeUndefined();
    expect(updateSessionRuntimeBindingInDbMock).not.toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ providerSessionId: "session-1" }),
    );
    expect(persistSessionToDbMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ providerSessionId: "session-1" }),
    );
  });

  it("persists the Claude native ID only after the system/init capture hook fires", async () => {
    storeMock.getSession.mockReturnValue({
      sessionId: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "claude",
      role: "CRAFTER",
      routaAgentId: "routa-agent-claude",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    managerMock.createClaudeSession.mockResolvedValue("session-1");

    await ensureSessionRuntime(defaultArgs({
      allowFreshCreate: true,
      buildMcpConfigForClaude: vi.fn(async () => []),
    }));

    // Before system/init: nothing native was persisted.
    expect(storeMock.setProviderSessionId).not.toHaveBeenCalled();

    const onSessionId = managerMock.createClaudeSession.mock.calls[0][9];
    expect(typeof onSessionId).toBe("function");
    onSessionId("claude-native-abc");

    expect(storeMock.setProviderSessionId).toHaveBeenCalledWith("session-1", "claude-native-abc");
    expect(updateSessionRuntimeBindingInDbMock).toHaveBeenCalledWith("session-1", {
      providerSessionId: "claude-native-abc",
    });
  });

  it("keeps the prior native ID on seeded Claude native resume until a new system/init arrives", async () => {
    loadSessionFromDbMock.mockResolvedValue({
      id: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "claude",
      role: "CRAFTER",
      routaAgentId: "routa-agent-claude",
      providerSessionId: "claude-native-9",
      firstPromptSent: true,
    });
    managerMock.createClaudeSession.mockResolvedValue("session-1");

    await ensureSessionRuntime(defaultArgs({
      buildMcpConfigForClaude: vi.fn(async () => []),
    }));

    // Seeded with the persisted native ID...
    expect(managerMock.createClaudeSession.mock.calls[0][8]).toBe("claude-native-9");
    // ...and the recovery write keeps that native ID (NOT the returned Routa
    // Session ID) until the provider reports a new one via system/init.
    const upserted = storeMock.upsertSession.mock.calls[0][0];
    expect(upserted.providerSessionId).toBe("claude-native-9");
    expect(upserted.routaAgentId).toBe("routa-agent-claude");
    expect(updateSessionRuntimeBindingInDbMock).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ providerSessionId: "claude-native-9" }),
    );

    // When the resumed CLI reports a NEW native session ID, it replaces it.
    const onSessionId = managerMock.createClaudeSession.mock.calls[0][9];
    onSessionId("claude-native-10");
    expect(storeMock.setProviderSessionId).toHaveBeenCalledWith("session-1", "claude-native-10");
    expect(updateSessionRuntimeBindingInDbMock).toHaveBeenCalledWith("session-1", {
      providerSessionId: "claude-native-10",
    });
  });

  it("does not persist the synthetic SDK runtime handle as providerSessionId", async () => {
    loadSessionFromDbMock.mockResolvedValue({
      id: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "claude-code-sdk",
      role: "CRAFTER",
      routaAgentId: "routa-agent-sdk",
    });
    // The SDK adapter resolves to a synthetic runtime handle, not a native ID.
    managerMock.createClaudeCodeSdkSession.mockResolvedValue("claude-sdk-1723370000000");

    await ensureSessionRuntime(defaultArgs());

    const upserted = storeMock.upsertSession.mock.calls[0][0];
    expect(upserted.providerSessionId).toBeUndefined();
    expect(upserted.routaAgentId).toBe("routa-agent-sdk");
    expect(updateSessionRuntimeBindingInDbMock).not.toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ providerSessionId: "claude-sdk-1723370000000" }),
    );
  });

  it("treats a providerSessionId equal to the Routa Session ID as absent when resolving the Claude strategy", () => {
    const polluted = resolveProviderRecoveryStrategy("claude", undefined, {
      id: "session-1",
      cwd: "/w",
      workspaceId: "ws-1",
      providerSessionId: "session-1",
    });
    expect(polluted.strategy).toBe("context_rebuild");

    const pollutedSdk = resolveProviderRecoveryStrategy("claude-code-sdk", undefined, {
      id: "session-2",
      cwd: "/w",
      workspaceId: "ws-1",
      providerSessionId: "session-2",
    });
    expect(pollutedSdk.strategy).toBe("context_rebuild");
  });

  it("does not overwrite the persisted native ID with the live Claude runtime handle when attaching", async () => {
    managerMock.hasActiveSession.mockReturnValue(true);
    // For Claude CLI sessions the manager's runtime handle IS the Routa ID.
    managerMock.getAcpSessionId.mockReturnValue("session-1");
    storeMock.getSession.mockReturnValue({
      sessionId: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "claude",
      routaAgentId: "routa-agent-claude",
      providerSessionId: "claude-native-7",
      createdAt: "2026-08-10T00:00:00.000Z",
    });

    await ensureSessionRuntime(defaultArgs());

    const upserted = storeMock.upsertSession.mock.calls[0][0];
    expect(upserted.providerSessionId).toBe("claude-native-7");
    expect(upserted.routaAgentId).toBe("routa-agent-claude");
  });

  // ── Bounded context rebuild: recovery envelope (P0) ──────────────────────
  // A context rebuild must inject ONE bounded, clearly-marked recovery
  // envelope built from durable metadata. Native resume success must never
  // receive the envelope; injection happens exactly once.

  function recoveryEnvelopeFixture() {
    return {
      schema: "routa.recovery-envelope@1",
      session: { sessionId: "session-1", cwd: "/workspace", workspaceId: "ws-1" },
      recentHistory: [],
      droppedHistoryCount: 0,
    };
  }

  it("injects the recovery envelope into a Claude rebuild via the append-system-prompt channel", async () => {
    storeMock.getSession.mockReturnValue({
      sessionId: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "claude",
      role: "CRAFTER",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    managerMock.createClaudeSession.mockResolvedValue("session-1");
    collectRecoveryEnvelopeMock.mockResolvedValue(recoveryEnvelopeFixture());

    const result = await ensureSessionRuntime(defaultArgs({
      allowFreshCreate: true,
      buildMcpConfigForClaude: vi.fn(async () => []),
    }));

    expect(collectRecoveryEnvelopeMock).toHaveBeenCalledTimes(1);
    expect(collectRecoveryEnvelopeMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      provider: "claude",
      cwd: "/workspace",
      workspaceId: "ws-1",
    }));
    // arg[10] is the append-system-prompt channel of the Claude CLI.
    const appendSystemPrompt = managerMock.createClaudeSession.mock.calls[0][10];
    expect(appendSystemPrompt).toContain("routa-internal-recovery-context");
    expect(appendSystemPrompt).toContain("NOT a user message");
    expect(result.recoveryEnvelope).toEqual(recoveryEnvelopeFixture());
    // Claude rebuilds use the system channel; no pending prefix is queued.
    expect(setPendingRecoveryContextMock).not.toHaveBeenCalled();
  });

  it("does not collect or inject a recovery envelope when Claude native resume succeeds", async () => {
    loadSessionFromDbMock.mockResolvedValue({
      id: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "claude",
      role: "CRAFTER",
      routaAgentId: "routa-agent-claude",
      providerSessionId: "claude-native-9",
      firstPromptSent: true,
    });
    managerMock.createClaudeSession.mockResolvedValue("session-1");

    const result = await ensureSessionRuntime(defaultArgs({
      buildMcpConfigForClaude: vi.fn(async () => []),
    }));

    expect(result.resumeMode).toBe("native");
    // Seeded native resume keeps the provider's own conversation context.
    expect(managerMock.createClaudeSession.mock.calls[0][8]).toBe("claude-native-9");
    expect(managerMock.createClaudeSession.mock.calls[0][10]).toBeUndefined();
    expect(collectRecoveryEnvelopeMock).not.toHaveBeenCalled();
    expect(setPendingRecoveryContextMock).not.toHaveBeenCalled();
    expect(result.recoveryEnvelope).toBeUndefined();
  });

  it("injects the envelope exactly once, only on the rebuild attempt after native resume fails", async () => {
    loadSessionFromDbMock.mockResolvedValue({
      id: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "claude",
      role: "CRAFTER",
      providerSessionId: "claude-native-gone",
      firstPromptSent: true,
    });
    managerMock.createClaudeSession
      .mockRejectedValueOnce(new Error("no such session"))
      .mockResolvedValueOnce("session-1");
    collectRecoveryEnvelopeMock.mockResolvedValue(recoveryEnvelopeFixture());

    const result = await ensureSessionRuntime(defaultArgs({
      buildMcpConfigForClaude: vi.fn(async () => []),
    }));

    expect(managerMock.createClaudeSession).toHaveBeenCalledTimes(2);
    // The native-resume attempt gets no injected context...
    expect(managerMock.createClaudeSession.mock.calls[0][10]).toBeUndefined();
    // ...the bounded rebuild gets the envelope.
    expect(managerMock.createClaudeSession.mock.calls[1][10]).toContain("routa-internal-recovery-context");
    // Collected exactly once across both attempts.
    expect(collectRecoveryEnvelopeMock).toHaveBeenCalledTimes(1);
    expect(result.resumeMode).toBe("recreated");
    expect(result.recoveryEnvelope).toEqual(recoveryEnvelopeFixture());
  });

  it("appends the envelope to the Claude Code SDK systemPromptAppend on rebuild", async () => {
    loadSessionFromDbMock.mockResolvedValue({
      id: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "claude-code-sdk",
      role: "CRAFTER",
      specialistSystemPrompt: "SPECIALIST-PROMPT",
    });
    managerMock.createClaudeCodeSdkSession.mockResolvedValue("claude-sdk-handle");
    collectRecoveryEnvelopeMock.mockResolvedValue(recoveryEnvelopeFixture());

    const result = await ensureSessionRuntime(defaultArgs());

    const options = managerMock.createClaudeCodeSdkSession.mock.calls[0][3];
    expect(options.systemPromptAppend).toContain("SPECIALIST-PROMPT");
    expect(options.systemPromptAppend).toContain("routa-internal-recovery-context");
    expect(options.sdkSessionId).toBeUndefined();
    expect(result.recoveryEnvelope).toEqual(recoveryEnvelopeFixture());
    expect(setPendingRecoveryContextMock).not.toHaveBeenCalled();
  });

  it("queues a one-shot recovery context prefix for providers without a system append channel", async () => {
    loadSessionFromDbMock.mockResolvedValue({
      id: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "opencode",
      role: "CRAFTER",
      firstPromptSent: true,
    });
    getPresetByIdMock.mockReturnValue({ id: "opencode", resume: { supported: true, mode: "replay" } });
    managerMock.createSession.mockResolvedValue("acp-fresh");
    collectRecoveryEnvelopeMock.mockResolvedValue(recoveryEnvelopeFixture());

    const result = await ensureSessionRuntime(defaultArgs());

    expect(managerMock.createSession).toHaveBeenCalledTimes(1);
    expect(setPendingRecoveryContextMock).toHaveBeenCalledTimes(1);
    expect(setPendingRecoveryContextMock).toHaveBeenCalledWith(
      "session-1",
      expect.stringContaining("routa-internal-recovery-context"),
    );
    expect(setPendingRecoveryContextMock.mock.calls[0][1]).toContain("NOT a user message");
    expect(result.recoveryEnvelope).toEqual(recoveryEnvelopeFixture());
  });

  it("does not queue a recovery context when standard ACP native resume succeeds", async () => {
    loadSessionFromDbMock.mockResolvedValue({
      id: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "codex",
      role: "CRAFTER",
      providerSessionId: "codex-native-77",
      firstPromptSent: true,
    });
    managerMock.loadSession.mockResolvedValue("codex-native-77");

    const result = await ensureSessionRuntime(defaultArgs());

    expect(result.resumeMode).toBe("native");
    expect(collectRecoveryEnvelopeMock).not.toHaveBeenCalled();
    expect(setPendingRecoveryContextMock).not.toHaveBeenCalled();
    expect(result.recoveryEnvelope).toBeUndefined();
  });

  it("still recovers when envelope collection fails (no injection, no error)", async () => {
    storeMock.getSession.mockReturnValue({
      sessionId: "session-1",
      cwd: "/workspace",
      workspaceId: "ws-1",
      provider: "claude",
      role: "CRAFTER",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    managerMock.createClaudeSession.mockResolvedValue("session-1");
    collectRecoveryEnvelopeMock.mockRejectedValue(new Error("collector exploded"));

    const result = await ensureSessionRuntime(defaultArgs({
      allowFreshCreate: true,
      buildMcpConfigForClaude: vi.fn(async () => []),
    }));

    expect(result.status).toBe("recovered");
    expect(managerMock.createClaudeSession.mock.calls[0][10]).toBeUndefined();
    expect(result.recoveryEnvelope).toBeUndefined();
  });
});
