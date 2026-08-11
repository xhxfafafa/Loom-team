import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AcpSessionKillResult } from "../acp-process-manager";

const persistSessionHistorySnapshotMock = vi.hoisted(() => vi.fn(async () => {}));
const getAcpProcessManagerMock = vi.hoisted(() => vi.fn());
const getHttpSessionStoreMock = vi.hoisted(() => vi.fn());
const loadHistorySinceEventIdFromDbMock = vi.hoisted(() =>
  vi.fn(async (_sessionId: string, _afterEventId: string) => [] as Array<{ eventId?: string | null }>),
);
const isProviderSessionIdDurableMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@/core/acp/session-history", () => ({
  persistSessionHistorySnapshot: persistSessionHistorySnapshotMock,
}));

vi.mock("@/core/acp/processer", () => ({
  getAcpProcessManager: getAcpProcessManagerMock,
}));

vi.mock("@/core/acp/http-session-store", () => ({
  getHttpSessionStore: getHttpSessionStoreMock,
}));

// The completed-release receipt check reads durable parent history; keep the
// real pure receipt scanner (team-report-delivery) but isolate the DB layer.
vi.mock("@/core/acp/session-db-persister", () => ({
  loadHistorySinceEventIdFromDb: loadHistorySinceEventIdFromDbMock,
  isProviderSessionIdDurable: isProviderSessionIdDurableMock,
}));

const {
  cleanupSessionRuntimesForMemory,
  finalizeAndRemoveSessions,
  finalizeSessionRuntime,
  hasActiveSessionDependency,
  isAutoReleaseCompletedClaudeEnabled,
  isSessionRecoveryReady,
} = await import("../session-runtime-finalizer");

function createOrderTracker() {
  const calls: string[] = [];
  const spy = (name: string, impl?: (...args: unknown[]) => unknown) =>
    vi.fn((...args: unknown[]) => {
      calls.push(name);
      return impl ? impl(...args) : undefined;
    });
  return { calls, spy };
}

function createStoreMock(overrides: Record<string, unknown> = {}) {
  const base = {
    getSession: vi.fn(() => ({ sessionId: "s-1", parentSessionId: undefined as string | undefined })),
    isSessionStreaming: vi.fn(() => false),
    listSessions: vi.fn((): Array<{ sessionId: string; parentSessionId?: string }> => []),
    flushAgentBuffer: vi.fn(),
    flushSessionTraces: vi.fn(),
    markSessionRuntimeRelease: vi.fn(),
    releaseTransientRuntimeBuffers: vi.fn(),
    deleteSession: vi.fn(() => true),
    getConsolidatedHistory: vi.fn(() => []),
    collectEvictableSessionIds: vi.fn(() => [] as string[]),
  };
  return Object.assign(base, overrides);
}

function createManagerMock(overrides: Record<string, unknown> = {}) {
  const base = {
    hasActiveSession: vi.fn(() => false),
    hasPendingInteraction: vi.fn(() => false),
    killSession: vi.fn(async (sessionId: string): Promise<AcpSessionKillResult> => ({
      sessionId,
      killed: true,
      runtimeKind: "claude-process",
      mcpCleaned: true,
      errors: [],
    })),
  };
  return Object.assign(base, overrides);
}

describe("session-runtime-finalizer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadHistorySinceEventIdFromDbMock.mockImplementation(
      async (_sessionId: string, _afterEventId: string) => [] as Array<{ eventId?: string | null }>,
    );
    isProviderSessionIdDurableMock.mockResolvedValue(true);
    getAcpProcessManagerMock.mockReturnValue(createManagerMock());
    getHttpSessionStoreMock.mockReturnValue(createStoreMock());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("isAutoReleaseCompletedClaudeEnabled", () => {
    it("defaults to enabled and honors explicit values", () => {
      vi.stubEnv("ROUTA_AUTO_RELEASE_COMPLETED_CLAUDE", "");
      expect(isAutoReleaseCompletedClaudeEnabled()).toBe(true);

      vi.stubEnv("ROUTA_AUTO_RELEASE_COMPLETED_CLAUDE", "1");
      expect(isAutoReleaseCompletedClaudeEnabled()).toBe(true);

      vi.stubEnv("ROUTA_AUTO_RELEASE_COMPLETED_CLAUDE", "0");
      expect(isAutoReleaseCompletedClaudeEnabled()).toBe(false);

      vi.stubEnv("ROUTA_AUTO_RELEASE_COMPLETED_CLAUDE", "false");
      expect(isAutoReleaseCompletedClaudeEnabled()).toBe(false);
    });
  });

  describe("finalizeSessionRuntime(completed)", () => {
    it("persists history/trace before killing the process and releasing buffers", async () => {
      const { calls, spy } = createOrderTracker();
      const store = createStoreMock({
        flushAgentBuffer: spy("flushAgentBuffer"),
        flushSessionTraces: spy("flushSessionTraces"),
        markSessionRuntimeRelease: spy("markSessionRuntimeRelease"),
        releaseTransientRuntimeBuffers: spy("releaseTransientRuntimeBuffers"),
      });
      const manager = createManagerMock({ killSession: spy("killSession", async () => ({
        sessionId: "s-1",
        killed: true,
        runtimeKind: "claude-process",
        mcpCleaned: true,
        errors: [],
      })) });
      persistSessionHistorySnapshotMock.mockImplementation(async () => {
        calls.push("persistSessionHistorySnapshot");
      });

      const release = await finalizeSessionRuntime("s-1", "completed", { store, manager });

      expect(release.released).toBe(true);
      expect(calls).toEqual([
        "flushAgentBuffer",
        "flushSessionTraces",
        "persistSessionHistorySnapshot",
        "markSessionRuntimeRelease",
        "killSession",
        "releaseTransientRuntimeBuffers",
      ]);
      expect(persistSessionHistorySnapshotMock).toHaveBeenCalledWith("s-1", store);
      expect(store.markSessionRuntimeRelease).toHaveBeenCalledWith("s-1", "completed");
    });

    it("keeps the runtime alive when the feature flag is disabled", async () => {
      vi.stubEnv("ROUTA_AUTO_RELEASE_COMPLETED_CLAUDE", "0");
      const store = createStoreMock();
      const manager = createManagerMock();

      const release = await finalizeSessionRuntime("s-1", "completed", { store, manager });

      expect(release).toMatchObject({ released: false, skipReason: "auto-release-disabled" });
      expect(manager.killSession).not.toHaveBeenCalled();
      expect(persistSessionHistorySnapshotMock).not.toHaveBeenCalled();
    });

    it("keeps the runtime alive while the session is streaming", async () => {
      const store = createStoreMock({ isSessionStreaming: vi.fn(() => true) });
      const manager = createManagerMock();

      const release = await finalizeSessionRuntime("s-1", "completed", { store, manager });

      expect(release).toMatchObject({ released: false, skipReason: "streaming" });
      expect(manager.killSession).not.toHaveBeenCalled();
    });

    it("keeps the runtime alive when a child session is still active", async () => {
      const store = createStoreMock({
        listSessions: vi.fn(() => [{ sessionId: "child-1", parentSessionId: "s-1" }]),
      });
      const manager = createManagerMock({
        hasActiveSession: vi.fn((sessionId: string) => sessionId === "child-1"),
      });

      const release = await finalizeSessionRuntime("s-1", "completed", { store, manager });

      expect(release).toMatchObject({ released: false, skipReason: "active-dependency" });
      expect(manager.killSession).not.toHaveBeenCalled();
    });

    it("no longer pins a completed child to an active parent once the report is durable", async () => {
      const store = createStoreMock({
        getSession: vi.fn(() => ({ sessionId: "child-1", parentSessionId: "parent-1" })),
      });
      const manager = createManagerMock({
        hasActiveSession: vi.fn((sessionId: string) => sessionId === "parent-1"),
      });
      loadHistorySinceEventIdFromDbMock.mockResolvedValue([
        { eventId: "team-report:parent-1:child-1:task-1:0:delivered" },
      ]);

      // An active parent alone is not a dependency anymore: the completion
      // report is durable and a follow-up delegation recovers the child.
      expect(hasActiveSessionDependency("child-1", { store, manager })).toBe(false);

      const release = await finalizeSessionRuntime("child-1", "completed", { store, manager });
      expect(release.released).toBe(true);
      expect(manager.killSession).toHaveBeenCalledWith("child-1");
    });

    it("releases when no dependency is active and the report receipt is durable", async () => {
      const store = createStoreMock({
        getSession: vi.fn(() => ({ sessionId: "child-1", parentSessionId: "parent-1" })),
        listSessions: vi.fn(() => [{ sessionId: "child-2", parentSessionId: "child-1" }]),
      });
      const manager = createManagerMock({ hasActiveSession: vi.fn(() => false) });
      loadHistorySinceEventIdFromDbMock.mockResolvedValue([
        { eventId: "team-report:parent-1:child-1:task-9:2:delivered" },
      ]);

      const release = await finalizeSessionRuntime("child-1", "completed", { store, manager });

      expect(release.released).toBe(true);
      expect(manager.killSession).toHaveBeenCalledWith("child-1");
      expect(loadHistorySinceEventIdFromDbMock).toHaveBeenCalledWith("parent-1", "");
    });

    it("never auto-releases a ROUTA Team Lead (idle Lead release stays disabled)", async () => {
      const store = createStoreMock({
        getSession: vi.fn(() => ({ sessionId: "lead-1", role: "ROUTA" })),
      });
      const manager = createManagerMock();

      const release = await finalizeSessionRuntime("lead-1", "completed", { store, manager });

      expect(release).toMatchObject({ released: false, skipReason: "auto-release-disabled" });
      expect(manager.killSession).not.toHaveBeenCalled();
      expect(persistSessionHistorySnapshotMock).not.toHaveBeenCalled();
    });

    it("keeps the runtime alive while an interactive request is pending", async () => {
      const store = createStoreMock();
      const manager = createManagerMock({ hasPendingInteraction: vi.fn(() => true) });

      const release = await finalizeSessionRuntime("s-1", "completed", { store, manager });

      expect(release).toMatchObject({ released: false, skipReason: "pending-interaction" });
      expect(manager.killSession).not.toHaveBeenCalled();
    });

    it("keeps a completed child alive until its report receipt is durable", async () => {
      const store = createStoreMock({
        getSession: vi.fn(() => ({ sessionId: "child-1", parentSessionId: "parent-1" })),
      });
      const manager = createManagerMock();
      // A recorded-but-not-delivered report event carries no receipt.
      loadHistorySinceEventIdFromDbMock.mockResolvedValue([
        { eventId: "team-report:parent-1:child-1:task-1:0" },
      ]);

      const release = await finalizeSessionRuntime("child-1", "completed", { store, manager });

      expect(release).toMatchObject({ released: false, skipReason: "report-not-delivered" });
      expect(manager.killSession).not.toHaveBeenCalled();
    });

    it("treats a receipt-lookup failure as not delivered and retains the runtime", async () => {
      const store = createStoreMock({
        getSession: vi.fn(() => ({ sessionId: "child-1", parentSessionId: "parent-1" })),
      });
      const manager = createManagerMock();
      loadHistorySinceEventIdFromDbMock.mockRejectedValue(new Error("db offline"));

      const release = await finalizeSessionRuntime("child-1", "completed", { store, manager });

      expect(release).toMatchObject({ released: false, skipReason: "report-not-delivered" });
      expect(manager.killSession).not.toHaveBeenCalled();
    });

    it("keeps a claude-family runtime alive without a persisted provider session ID", async () => {
      const store = createStoreMock({
        getSession: vi.fn(() => ({
          sessionId: "s-1",
          provider: "claude-code-sdk",
          firstPromptSent: true,
        })),
      });
      const manager = createManagerMock();

      const release = await finalizeSessionRuntime("s-1", "completed", { store, manager });

      expect(release).toMatchObject({ released: false, skipReason: "recovery-not-ready" });
      expect(manager.killSession).not.toHaveBeenCalled();
    });

    it("releases a claude-family runtime once the provider session ID is persisted", async () => {
      const store = createStoreMock({
        getSession: vi.fn(() => ({
          sessionId: "s-1",
          provider: "claude-code-sdk",
          providerSessionId: "native-session-123",
        })),
      });
      const manager = createManagerMock();

      const release = await finalizeSessionRuntime("s-1", "completed", { store, manager });

      expect(release.released).toBe(true);
      expect(manager.killSession).toHaveBeenCalledWith("s-1");
    });

    it("keeps the runtime alive when the native ID exists only in memory", async () => {
      const store = createStoreMock({
        getSession: vi.fn(() => ({
          sessionId: "s-1",
          provider: "claude-code-sdk",
          providerSessionId: "native-session-not-durable",
        })),
      });
      const manager = createManagerMock();
      isProviderSessionIdDurableMock.mockResolvedValueOnce(false);

      const release = await finalizeSessionRuntime("s-1", "completed", { store, manager });

      expect(release).toMatchObject({ released: false, skipReason: "recovery-not-ready" });
      expect(isProviderSessionIdDurableMock).toHaveBeenCalledWith(
        "s-1",
        "native-session-not-durable",
      );
      expect(manager.killSession).not.toHaveBeenCalled();
    });

    it("skips with history-not-durable and keeps the process when persistence fails", async () => {
      const store = createStoreMock();
      const manager = createManagerMock();
      persistSessionHistorySnapshotMock.mockRejectedValueOnce(new Error("disk full"));

      const release = await finalizeSessionRuntime("s-1", "completed", { store, manager });

      expect(release.released).toBe(false);
      expect(release.skipReason).toBe("history-not-durable");
      expect(release.errors.some((entry) => entry.includes("disk full"))).toBe(true);
      expect(manager.killSession).not.toHaveBeenCalled();
      expect(store.markSessionRuntimeRelease).not.toHaveBeenCalled();
    });
  });

  describe("isSessionRecoveryReady", () => {
    it("is ready when a provider-native session ID is persisted", () => {
      expect(isSessionRecoveryReady({ provider: "claude-code-sdk", providerSessionId: "native-1" })).toBe(true);
      expect(isSessionRecoveryReady({ provider: "codex", providerSessionId: "codex-1", firstPromptSent: true })).toBe(true);
    });

    it("is not ready for claude-family runtimes without a native ID", () => {
      expect(isSessionRecoveryReady({ provider: "claude" })).toBe(false);
      expect(isSessionRecoveryReady({ provider: "claude-code-sdk", firstPromptSent: true })).toBe(false);
    });

    it("is ready for codex before the first prompt (nothing provider-side to lose)", () => {
      expect(isSessionRecoveryReady({ provider: "codex" })).toBe(true);
    });

    it("is not ready for codex after the first prompt without a native ID", () => {
      expect(isSessionRecoveryReady({ provider: "codex", firstPromptSent: true })).toBe(false);
    });

    it("is ready for replay-only providers and unknown records", () => {
      expect(isSessionRecoveryReady({ provider: "opencode", firstPromptSent: true })).toBe(true);
      expect(isSessionRecoveryReady({})).toBe(true);
      expect(isSessionRecoveryReady(undefined)).toBe(true);
    });

    it("ignores a providerSessionId that equals the Routa Session ID (pollution guard)", () => {
      // A Routa Session ID leaked into provider_session_id is NOT a native
      // resume handle; the finalizer must not treat it as recovery-ready.
      expect(isSessionRecoveryReady({ provider: "claude", providerSessionId: "s-1" }, "s-1")).toBe(false);
      expect(isSessionRecoveryReady({ provider: "claude-code-sdk", providerSessionId: "s-1" }, "s-1")).toBe(false);
      // A real native ID still counts.
      expect(isSessionRecoveryReady({ provider: "claude", providerSessionId: "native-1" }, "s-1")).toBe(true);
    });

    it("does not release a completed Claude runtime whose only providerSessionId is the Routa Session ID", async () => {
      const store = createStoreMock({
        getSession: vi.fn(() => ({
          sessionId: "s-1",
          provider: "claude",
          role: "CRAFTER",
          providerSessionId: "s-1",
        })),
      });
      const manager = createManagerMock();

      const release = await finalizeSessionRuntime("s-1", "completed", { store, manager });

      expect(release.released).toBe(false);
      expect(release.skipReason).toBe("recovery-not-ready");
      expect(manager.killSession).not.toHaveBeenCalled();
    });
  });

  describe("finalizeSessionRuntime(explicit reasons)", () => {
    it("reclaims a disconnect even while streaming (no policy gates)", async () => {
      const store = createStoreMock({ isSessionStreaming: vi.fn(() => true) });
      const manager = createManagerMock();

      const release = await finalizeSessionRuntime("s-1", "disconnect", { store, manager });

      expect(release.released).toBe(true);
      expect(manager.killSession).toHaveBeenCalledWith("s-1");
      expect(store.releaseTransientRuntimeBuffers).toHaveBeenCalledWith("s-1");
    });

    it("still reclaims a ROUTA Team Lead on explicit disconnect (gates are completed-only)", async () => {
      const store = createStoreMock({
        getSession: vi.fn(() => ({ sessionId: "lead-1", role: "ROUTA" })),
      });
      const manager = createManagerMock();

      const release = await finalizeSessionRuntime("lead-1", "disconnect", { store, manager });

      expect(release.released).toBe(true);
      expect(manager.killSession).toHaveBeenCalledWith("lead-1");
    });

    it("reclaims delete/team-run-delete/stale-cleanup regardless of the feature flag", async () => {
      vi.stubEnv("ROUTA_AUTO_RELEASE_COMPLETED_CLAUDE", "0");

      for (const reason of ["delete", "team-run-delete", "stale-cleanup", "memory-cleanup"] as const) {
        const store = createStoreMock();
        const manager = createManagerMock();

        const release = await finalizeSessionRuntime("s-1", reason, { store, manager });

        expect(release.released).toBe(true);
        expect(manager.killSession).toHaveBeenCalledWith("s-1");
      }
    });

    it("collects kill errors without aborting buffer release", async () => {
      const store = createStoreMock();
      const manager = createManagerMock({
        killSession: vi.fn(async (sessionId: string) => ({
          sessionId,
          killed: false,
          mcpCleaned: false,
          errors: ["MCP cleanup failed: proxy stuck"],
        })),
      });

      const release = await finalizeSessionRuntime("s-1", "delete", { store, manager });

      expect(release.released).toBe(false);
      expect(release.errors).toContain("MCP cleanup failed: proxy stuck");
      expect(store.releaseTransientRuntimeBuffers).toHaveBeenCalled();
    });

    it("survives a throwing killSession and reports the failure", async () => {
      const store = createStoreMock();
      const manager = createManagerMock({
        killSession: vi.fn(async () => {
          throw new Error("kill exploded");
        }),
      });

      const release = await finalizeSessionRuntime("s-1", "disconnect", { store, manager });

      expect(release.released).toBe(false);
      expect(release.process).toBeUndefined();
      expect(release.errors.some((entry) => entry.includes("kill exploded"))).toBe(true);
    });

    it("normalizes a void killSession result from legacy callers", async () => {
      const store = createStoreMock();
      const manager = createManagerMock({ killSession: vi.fn(async () => undefined) });

      const release = await finalizeSessionRuntime("s-1", "disconnect", { store, manager });

      expect(release.released).toBe(true);
      expect(release.process).toMatchObject({ killed: false, mcpCleaned: false });
    });
  });

  describe("finalizeAndRemoveSessions", () => {
    it("finalizes, deletes, and reports terminated processes and MCP cleanups", async () => {
      const store = createStoreMock();
      const manager = createManagerMock();

      const report = await finalizeAndRemoveSessions(["a", "b"], "memory-cleanup", { store, manager });

      expect(report).toMatchObject({
        sessionsRemoved: 2,
        agentProcessesTerminated: 2,
        mcpProxiesCleaned: 2,
        failures: [],
      });
      expect(store.deleteSession).toHaveBeenCalledWith("a");
      expect(store.deleteSession).toHaveBeenCalledWith("b");
    });

    it("skips sessions that started streaming during the async gap", async () => {
      const store = createStoreMock({
        isSessionStreaming: vi.fn((sessionId: string) => sessionId === "busy"),
      });
      const manager = createManagerMock();

      const report = await finalizeAndRemoveSessions(["busy", "idle"], "stale-cleanup", { store, manager });

      expect(manager.killSession).toHaveBeenCalledTimes(1);
      expect(manager.killSession).toHaveBeenCalledWith("idle");
      expect(report.sessionsRemoved).toBe(1);
    });

    it("reports finalization failures per session without masking successes", async () => {
      const store = createStoreMock();
      const manager = createManagerMock({
        killSession: vi.fn(async (sessionId: string) => {
          if (sessionId === "broken") throw new Error("boom");
          return { sessionId, killed: true, mcpCleaned: true, errors: [] };
        }),
      });

      const report = await finalizeAndRemoveSessions(["broken", "fine"], "memory-cleanup", { store, manager });

      expect(report.sessionsRemoved).toBe(1);
      expect(report.agentProcessesTerminated).toBe(1);
      expect(report.failures).toEqual([
        { sessionId: "broken", step: "finalize", error: "killSession failed: boom" },
        {
          sessionId: "broken",
          step: "retained-for-retry",
          error: "runtime release was incomplete; session was retained for a later cleanup retry",
        },
      ]);
      expect(store.deleteSession).not.toHaveBeenCalledWith("broken");
    });
  });

  describe("cleanupSessionRuntimesForMemory", () => {
    it("evicts sessions collected from the store and reports reclamation", async () => {
      const store = createStoreMock({
        collectEvictableSessionIds: vi.fn(() => ["stale-1"]),
      });
      const manager = createManagerMock();
      getHttpSessionStoreMock.mockReturnValue(store);
      getAcpProcessManagerMock.mockReturnValue(manager);

      const report = await cleanupSessionRuntimesForMemory({ aggressive: true });

      expect(store.collectEvictableSessionIds).toHaveBeenCalledWith({ aggressive: true });
      expect(report).toMatchObject({
        sessionsRemoved: 1,
        agentProcessesTerminated: 1,
        mcpProxiesCleaned: 1,
      });
    });
  });
});
