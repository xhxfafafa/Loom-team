/**
 * Unified session runtime finalization.
 *
 * A Routa session owns two categories of state:
 *
 * 1. Durable state — session metadata, message history, traces, DB/JSONL rows.
 *    This must survive any runtime release so a later prompt can recreate the
 *    session runtime and the UI keeps its history.
 * 2. Recreatable runtime state — the Claude/Codex/OpenCode process or adapter,
 *    MCP stdio proxies, SSE controllers, pending notification queues, and other
 *    in-memory buffers.
 *
 * Every terminal path (provider-confirmed completion, explicit disconnect,
 * delete, Team Run deletion, stale/memory cleanup) routes through
 * {@link finalizeSessionRuntime}, which applies the lifecycle in order:
 *
 *   persist history/trace -> mark release reason -> kill provider process
 *   -> clean MCP proxy/transport -> clear transient buffers
 *   -> retain durable session metadata
 */

import { getHttpSessionStore, type SessionUpdateNotification } from "@/core/acp/http-session-store";
import { persistSessionHistorySnapshot } from "@/core/acp/session-history";
import type { AcpSessionKillResult } from "@/core/acp/acp-process-manager";
import { getAcpProcessManager } from "@/core/acp/processer";

/** Why a session runtime is being released. */
export type SessionFinalizationReason =
  | "completed"
  | "disconnect"
  | "delete"
  | "team-run-delete"
  | "stale-cleanup"
  | "memory-cleanup";

/** Why an automatic (completed) release was skipped. */
export type SessionFinalizationSkipReason =
  | "auto-release-disabled"
  | "streaming"
  | "active-dependency";

export interface SessionRuntimeReleaseResult {
  sessionId: string;
  reason: SessionFinalizationReason;
  /** True when finalization ran and runtime resources were released. */
  released: boolean;
  /** Set when an automatic completion release was refused by policy. */
  skipReason?: SessionFinalizationSkipReason;
  /** Structured process/MCP kill result from the process manager. */
  process?: AcpSessionKillResult;
  /** Non-fatal errors collected while persisting or releasing. */
  errors: string[];
}

/** Truthful runtime reclamation report for memory-cleanup endpoints. */
export interface RuntimeCleanupReport {
  /** Logical session records removed from the in-memory store. */
  sessionsRemoved: number;
  /** Provider processes/adapters that were actually terminated. */
  agentProcessesTerminated: number;
  /** Terminated sessions whose MCP proxy/transport cleanup completed. */
  mcpProxiesCleaned: number;
  /** Individual failures, so a successful response cannot mask leaks. */
  failures: Array<{ sessionId: string; step: string; error: string }>;
}

interface FinalizableStore {
  getSession(sessionId: string): { parentSessionId?: string } | undefined;
  isSessionStreaming(sessionId: string): boolean;
  listSessions(): Array<{ sessionId: string; parentSessionId?: string }>;
  flushAgentBuffer(sessionId: string): void;
  flushSessionTraces(sessionId: string): void;
  markSessionRuntimeRelease(sessionId: string, reason: string): void;
  releaseTransientRuntimeBuffers(sessionId: string): void;
  deleteSession(sessionId: string): boolean;
  getConsolidatedHistory(sessionId: string): SessionUpdateNotification[];
}

interface FinalizableManager {
  hasActiveSession(sessionId: string): boolean;
  killSession(sessionId: string): Promise<AcpSessionKillResult | void>;
}

export interface SessionRuntimeFinalizerDeps {
  store?: FinalizableStore;
  manager?: FinalizableManager;
}

function resolveStore(deps?: SessionRuntimeFinalizerDeps): FinalizableStore {
  return (deps?.store ?? getHttpSessionStore()) as FinalizableStore;
}

function resolveManager(deps?: SessionRuntimeFinalizerDeps): FinalizableManager {
  return deps?.manager ?? getAcpProcessManager();
}

/**
 * Automatic release of completed Claude process sessions.
 * Enabled by default; set ROUTA_AUTO_RELEASE_COMPLETED_CLAUDE=0 (or "false")
 * to keep completed Claude processes alive. Explicit disconnect/delete and
 * cleanup paths reclaim resources regardless of this flag.
 */
export function isAutoReleaseCompletedClaudeEnabled(): boolean {
  const raw = process.env.ROUTA_AUTO_RELEASE_COMPLETED_CLAUDE;
  if (raw === undefined || raw === "") return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

/**
 * Whether the session participates in an active parent/child dependency that
 * must not be torn down: an active parent for this child session, or any child
 * session of this session whose runtime is still active.
 */
export function hasActiveSessionDependency(
  sessionId: string,
  deps?: SessionRuntimeFinalizerDeps,
): boolean {
  const store = resolveStore(deps);
  const manager = resolveManager(deps);

  const session = store.getSession(sessionId);
  if (!session) return false;

  if (session.parentSessionId && manager.hasActiveSession(session.parentSessionId)) {
    return true;
  }

  return store
    .listSessions()
    .some((candidate) => candidate.parentSessionId === sessionId && manager.hasActiveSession(candidate.sessionId));
}

function normalizeKillResult(
  sessionId: string,
  raw: AcpSessionKillResult | void,
): AcpSessionKillResult {
  if (raw && typeof raw === "object" && "sessionId" in raw) {
    return raw;
  }
  return { sessionId, killed: false, mcpCleaned: false, errors: [] };
}

/**
 * Release a session's runtime resources while preserving durable state.
 *
 * Only the `completed` reason is policy-gated (feature flag, streaming, and
 * active parent/child dependencies). Explicit reasons — disconnect, delete,
 * team-run-delete, stale-cleanup, memory-cleanup — always reclaim.
 */
export async function finalizeSessionRuntime(
  sessionId: string,
  reason: SessionFinalizationReason,
  deps?: SessionRuntimeFinalizerDeps,
): Promise<SessionRuntimeReleaseResult> {
  const store = resolveStore(deps);
  const manager = resolveManager(deps);
  const errors: string[] = [];

  if (reason === "completed") {
    if (!isAutoReleaseCompletedClaudeEnabled()) {
      return { sessionId, reason, released: false, skipReason: "auto-release-disabled", errors };
    }
    if (store.isSessionStreaming(sessionId)) {
      return { sessionId, reason, released: false, skipReason: "streaming", errors };
    }
    if (hasActiveSessionDependency(sessionId, deps)) {
      return { sessionId, reason, released: false, skipReason: "active-dependency", errors };
    }
  }

  // 1. Persist durable state before releasing anything.
  try {
    store.flushAgentBuffer(sessionId);
  } catch (error) {
    errors.push(`flush agent buffer failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    store.flushSessionTraces(sessionId);
  } catch (error) {
    errors.push(`flush traces failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await persistSessionHistorySnapshot(sessionId, store);
  } catch (error) {
    errors.push(`history persistence failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2. Mark the release reason on the activity record.
  try {
    store.markSessionRuntimeRelease(sessionId, reason);
  } catch (error) {
    errors.push(`mark release failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 3. Terminate the provider process/adapter and its MCP proxy/transport.
  let process: AcpSessionKillResult | undefined;
  try {
    process = normalizeKillResult(sessionId, await manager.killSession(sessionId));
    errors.push(...process.errors);
  } catch (error) {
    errors.push(`killSession failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 4. Clear transient buffers and SSE references; durable metadata stays.
  try {
    store.releaseTransientRuntimeBuffers(sessionId);
  } catch (error) {
    errors.push(`release transient buffers failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // A logical cleanup is not a successful runtime release when either the
  // provider process or its MCP transport reported an error. Callers surface
  // this distinction and retain the session as a retry handle.
  return { sessionId, reason, released: errors.length === 0, process, errors };
}

/**
 * Finalize and then logically remove a set of sessions (stale/memory cleanup).
 * Re-checks activity before each eviction so sessions touched during the async
 * gap are not removed.
 */
export async function finalizeAndRemoveSessions(
  sessionIds: string[],
  reason: SessionFinalizationReason,
  deps?: SessionRuntimeFinalizerDeps,
): Promise<RuntimeCleanupReport> {
  const store = resolveStore(deps);
  const report: RuntimeCleanupReport = {
    sessionsRemoved: 0,
    agentProcessesTerminated: 0,
    mcpProxiesCleaned: 0,
    failures: [],
  };

  for (const sessionId of sessionIds) {
    if (store.isSessionStreaming(sessionId)) {
      continue;
    }

    let release: SessionRuntimeReleaseResult;
    try {
      release = await finalizeSessionRuntime(sessionId, reason, deps);
    } catch (error) {
      report.failures.push({
        sessionId,
        step: "finalize",
        error: error instanceof Error ? error.message : String(error),
      });
      report.failures.push({
        sessionId,
        step: "retained-for-retry",
        error: "finalization threw before runtime reclamation could be confirmed",
      });
      continue;
    }

    for (const error of release.errors) {
      report.failures.push({ sessionId, step: "finalize", error });
    }
    if (release.process?.killed) {
      report.agentProcessesTerminated += 1;
      if (release.process.mcpCleaned) {
        report.mcpProxiesCleaned += 1;
      }
    }

    // Never discard the ownership record when a process or MCP cleanup failed:
    // it is the retry handle for a potentially live child runtime.
    if (release.errors.length === 0 && (!release.process || release.process.killed)) {
      if (store.deleteSession(sessionId)) {
        report.sessionsRemoved += 1;
      }
    } else {
      report.failures.push({
        sessionId,
        step: "retained-for-retry",
        error: "runtime release was incomplete; session was retained for a later cleanup retry",
      });
    }
  }

  return report;
}

/**
 * Runtime-aware replacement for the old record-only cleanupSessionStore:
 * collects evictable sessions and reclaims their processes/MCP proxies before
 * removing the logical records.
 */
export async function cleanupSessionRuntimesForMemory(options?: {
  aggressive?: boolean;
}): Promise<RuntimeCleanupReport> {
  const store = getHttpSessionStore();
  const evictable = store.collectEvictableSessionIds(options);
  return finalizeAndRemoveSessions(evictable, "memory-cleanup", { store });
}
