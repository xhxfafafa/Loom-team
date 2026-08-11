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
import { getPresetById } from "@/core/acp/acp-presets";

/** Why a session runtime is being released. */
export type SessionFinalizationReason =
  | "completed"
  | "disconnect"
  | "delete"
  | "team-run-delete"
  | "stale-cleanup"
  | "memory-cleanup";

/**
 * Why an automatic (completed) release was skipped.
 *
 * - auto-release-disabled: the feature flag is off, or the session is a Team
 *   Lead (ROUTA role) — idle Lead release stays disabled in version one.
 * - streaming: a prompt response is actively streaming.
 * - pending-interaction: the runtime still owes the user an interaction
 *   (pending permission prompt or user-input request).
 * - report-not-delivered: the child's completion report has no durable
 *   delivery receipt in the parent session yet.
 * - history-not-durable: transcript/trace flush or history persistence failed
 *   before the process could be released.
 * - active-dependency: a descendant session's runtime is still active.
 * - recovery-not-ready: no provider-native session ID is persisted and the
 *   adapter is not explicitly context-rebuild-only.
 */
export type SessionFinalizationSkipReason =
  | "auto-release-disabled"
  | "streaming"
  | "pending-interaction"
  | "report-not-delivered"
  | "history-not-durable"
  | "active-dependency"
  | "recovery-not-ready";

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

interface FinalizableSessionRecord {
  parentSessionId?: string;
  /** Session role; ROUTA marks a Team Lead whose idle release is disabled. */
  role?: string;
  provider?: string;
  /** Persisted provider-native session ID (native resume material). */
  providerSessionId?: string;
  firstPromptSent?: boolean;
}

interface FinalizableStore {
  getSession(sessionId: string): FinalizableSessionRecord | undefined;
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
  /** Optional probe for pending interactive requests; absent = no probe. */
  hasPendingInteraction?(sessionId: string): boolean;
  killSession(sessionId: string): Promise<AcpSessionKillResult | void>;
}

export interface SessionRuntimeFinalizerDeps {
  store?: FinalizableStore;
  manager?: FinalizableManager;
  verifyProviderSessionIdDurable?: (
    sessionId: string,
    providerSessionId: string,
  ) => Promise<boolean>;
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
 * Whether the session participates in an active dependency that must not be
 * torn down: a child session of this session whose runtime is still active.
 *
 * An ACTIVE PARENT deliberately does NOT pin a completed child anymore: the
 * completion report is durable (delivery receipt in the parent history), and
 * any follow-up delegation recovers the child runtime on demand through
 * `ensureSessionRuntime`. Letting the parent pin children would keep
 * completed child processes alive forever.
 */
export function hasActiveSessionDependency(
  sessionId: string,
  deps?: SessionRuntimeFinalizerDeps,
): boolean {
  const store = resolveStore(deps);
  const manager = resolveManager(deps);

  const session = store.getSession(sessionId);
  if (!session) return false;

  return store
    .listSessions()
    .some((candidate) => candidate.parentSessionId === sessionId && manager.hasActiveSession(candidate.sessionId));
}

/**
 * Whether a session can be faithfully restored after its runtime is released.
 *
 * Ready when:
 * - a provider-native session ID is persisted (native resume), or
 * - the provider never had provider-side state to lose: replay-only adapters
 *   are explicitly context-rebuild-only, and native-capable providers are
 *   lossless to rebuild before their first prompt.
 *
 * Claude-family runtimes without a persisted native ID are NOT ready: killing
 * them would discard the provider conversation, and they are neither
 * native-resumable nor explicitly rebuild-only.
 *
 * A `provider_session_id` equal to the Routa Session ID is a pollution
 * artifact (older recovery code persisted the Claude CLI runtime handle,
 * which IS the Routa Session ID) and is treated as ABSENT — it is not a
 * native resume handle.
 */
export function isSessionRecoveryReady(
  record: FinalizableSessionRecord | undefined,
  routaSessionId?: string,
): boolean {
  if (!record) return true;
  const nativeProviderSessionId =
    record.providerSessionId && record.providerSessionId !== routaSessionId
      ? record.providerSessionId
      : undefined;
  if (nativeProviderSessionId) return true;

  const provider = (record.provider ?? "").toLowerCase();
  if (provider === "claude" || provider === "claude-code-sdk") return false;

  const preset = getPresetById(provider);
  const nativeCapable = provider === "codex"
    || (preset?.resume?.supported === true
      && (preset.resume.mode === "native" || preset.resume.mode === "both"));
  if (nativeCapable) return !record.firstPromptSent;

  return true;
}

/**
 * Whether the parent session's durable history already carries a DELIVERED
 * Team report receipt for this child. Completion reports are the child's
 * hand-off to the Lead; the child runtime may only be released once that
 * hand-off is durable. Load failures are treated as "not delivered" so the
 * runtime is retained for a later retry instead of being released on an
 * unproven receipt.
 */
async function hasDurableTeamReportReceipt(
  parentSessionId: string,
  childSessionId: string,
): Promise<boolean> {
  try {
    const { loadHistorySinceEventIdFromDb } = await import("@/core/acp/session-db-persister");
    const { hasDeliveredTeamReportForChild } = await import("@/core/orchestration/team-report-delivery");
    const history = await loadHistorySinceEventIdFromDb(parentSessionId, "");
    return hasDeliveredTeamReportForChild(history, { parentSessionId, childSessionId });
  } catch (error) {
    console.warn(
      `[SessionRuntimeFinalizer] Could not verify team report receipt for child ${childSessionId} in parent ${parentSessionId}; retaining runtime`,
      error,
    );
    return false;
  }
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
 * Only the `completed` reason is policy-gated. A completed release is
 * allowed only when ALL checks pass, in order:
 *
 *   1. the auto-release feature flag is enabled;
 *   2. the session is not a Team Lead (ROUTA role) — idle Lead release is
 *      disabled in version one (deferred until recovery metrics prove it);
 *   3. no prompt stream is active;
 *   4. no interactive request is pending on the runtime;
 *   5. no descendant session still requires this runtime;
 *   6. the session is recovery-ready (native ID persisted, or explicitly
 *      context-rebuild-only);
 *   7. for Team children, the completion report has a durable delivery
 *      receipt in the parent session;
 *   8. history/trace flush and persistence succeed (checked during step 1
 *      below; failure skips as history-not-durable BEFORE killing anything).
 *
 * Explicit reasons — disconnect, delete, team-run-delete, stale-cleanup,
 * memory-cleanup — always reclaim.
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
    const skip = (skipReason: SessionFinalizationSkipReason): SessionRuntimeReleaseResult =>
      ({ sessionId, reason, released: false, skipReason, errors });

    if (!isAutoReleaseCompletedClaudeEnabled()) {
      return skip("auto-release-disabled");
    }
    const record = store.getSession(sessionId);
    // Version one never auto-releases an idle Team Lead. A suspended Lead is
    // recovered on demand; reclaiming it here is deferred to a follow-up
    // informed by recovery metrics.
    if (record?.role?.toUpperCase() === "ROUTA") {
      return skip("auto-release-disabled");
    }
    if (store.isSessionStreaming(sessionId)) {
      return skip("streaming");
    }
    if (manager.hasPendingInteraction?.(sessionId)) {
      return skip("pending-interaction");
    }
    if (hasActiveSessionDependency(sessionId, deps)) {
      return skip("active-dependency");
    }
    if (!isSessionRecoveryReady(record, sessionId)) {
      return skip("recovery-not-ready");
    }
    const nativeProviderSessionId = record?.providerSessionId !== sessionId
      ? record?.providerSessionId
      : undefined;
    if (nativeProviderSessionId) {
      const verifyDurability = deps?.verifyProviderSessionIdDurable
        ?? (await import("@/core/acp/session-db-persister")).isProviderSessionIdDurable;
      if (!(await verifyDurability(sessionId, nativeProviderSessionId))) {
        return skip("recovery-not-ready");
      }
    }
    // Team children hand their work back through a durable completion report.
    // Release is only safe once that report's delivery receipt exists in the
    // parent session; otherwise the child is still mid-conversation or its
    // hand-off has not been durably accepted.
    if (record?.parentSessionId
      && !(await hasDurableTeamReportReceipt(record.parentSessionId, sessionId))) {
      return skip("report-not-delivered");
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

  // For automatic completed releases, durable persistence is a PRECONDITION:
  // keep the runtime alive and retry on the next lifecycle/cleanup trigger
  // instead of killing the process while transcript state may be lost.
  if (reason === "completed" && errors.length > 0) {
    return { sessionId, reason, released: false, skipReason: "history-not-durable", errors };
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
