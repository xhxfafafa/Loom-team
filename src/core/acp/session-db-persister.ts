/**
 * Session DB Persister — persists ACP sessions to DB + local JSONL files.
 *
 * In local Node.js environments, sessions are also written to JSONL files
 * under ~/.routa/projects/{folder-slug}/sessions/ for file-level persistence.
 *
 * Kept in core/acp/ so relative require paths to ../db/* are stable
 * in both local-dev and Next.js compiled output.
 */

import { getDatabaseDriver, getPostgresDatabase } from "@/core/db/index";
import { PgAcpSessionStore } from "@/core/db/pg-acp-session-store";
import { SqliteAcpSessionStore } from "@/core/db/sqlite-stores";
import { findLocalSessionRecord, LocalSessionProvider } from "@/core/storage/local-session-provider";
import type { AcpSession } from "@/core/store/acp-session-store";
import type { SessionRecord, SessionJsonlEntry } from "@/core/storage/types";
import type { TeamChainId } from "@/core/orchestration/team-chain";
import {
  compactSessionHistoryForPersistence,
  compactSessionNotificationForPersistence,
} from "@/core/acp/session-notification-retention";

function isServerless(): boolean {
  return !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

/** Get a LocalSessionProvider for the given cwd (local environments only). */
function getLocalProvider(cwd: string): LocalSessionProvider | null {
  if (isServerless()) return null;
  return new LocalSessionProvider(cwd);
}

async function loadSqliteDatabaseModule() {
  return import("@/core/db/sqlite");
}

export interface SessionPersistData {
  id: string;
  name?: string;
  cwd: string;
  /** Git branch the session is scoped to (optional) */
  branch?: string;
  workspaceId: string;
  /**
   * Durable Routa logical agent ID. Optional so recovery paths can persist a
   * session without fabricating or overwriting it with a provider session ID.
   */
  routaAgentId?: string;
  /** Provider-native session ID (ACP/Claude/Codex); never derived from routaAgentId. */
  providerSessionId?: string;
  provider: string;
  role: string;
  modeId?: string;
  model?: string;
  /** Parent session ID for child (CRAFTER/GATE) sessions */
  parentSessionId?: string;
  specialistId?: string;
  /** Team execution chain for top-level team-agent-lead sessions; omitted = legacy Full Delivery. */
  teamChainId?: TeamChainId;
  executionMode?: "embedded" | "runner";
  ownerInstanceId?: string;
  leaseExpiresAt?: string;
  /**
   * Durable first-prompt flag. Recovery fallback writes must carry it so a
   * later native-resume gate (Codex rollout existence) stays correct.
   */
  firstPromptSent?: boolean;
  /** Durable creation timestamp; defaults to now for brand-new sessions. */
  createdAt?: Date;
}

export async function persistSessionToDb(data: SessionPersistData): Promise<void> {
  const driver = getDatabaseDriver();

  const now = new Date();
  const createdAt = data.createdAt ?? now;
  const sessionRecord: AcpSession = {
    id: data.id,
    name: data.name,
    cwd: data.cwd,
    branch: data.branch,
    workspaceId: data.workspaceId,
    routaAgentId: data.routaAgentId,
    providerSessionId: data.providerSessionId,
    provider: data.provider,
    role: data.role,
    modeId: data.modeId,
    model: data.model,
    firstPromptSent: data.firstPromptSent ?? false,
    messageHistory: [] as never[],
    parentSessionId: data.parentSessionId,
    specialistId: data.specialistId,
    teamChainId: data.teamChainId,
    executionMode: data.executionMode,
    ownerInstanceId: data.ownerInstanceId,
    leaseExpiresAt: data.leaseExpiresAt,
    createdAt,
    updatedAt: now,
  };

  // 1. Persist to DB (Postgres or SQLite)
  if (driver !== "memory") {
    try {
      if (driver === "postgres") {
        const db = getPostgresDatabase();
        await new PgAcpSessionStore(db).save(sessionRecord);
      } else {
        const { getSqliteDatabase } = await loadSqliteDatabaseModule();
        const db = getSqliteDatabase();
        await new SqliteAcpSessionStore(db).save(sessionRecord);
      }
      console.log(`[SessionDB] Persisted session to ${driver}: ${data.id}`);
    } catch (err) {
      console.error(`[SessionDB] Failed to persist session to ${driver}:`, err);
    }
  }

  // 2. Also persist to local JSONL file (non-serverless only)
  const local = getLocalProvider(data.cwd);
  if (local) {
    try {
      const record: SessionRecord = {
        id: data.id,
        name: data.name,
        cwd: data.cwd,
        branch: data.branch,
        workspaceId: data.workspaceId,
        routaAgentId: data.routaAgentId,
        providerSessionId: data.providerSessionId,
        provider: data.provider,
        role: data.role,
        modeId: data.modeId,
        model: data.model,
        parentSessionId: data.parentSessionId,
        specialistId: data.specialistId,
        teamChainId: data.teamChainId,
        executionMode: data.executionMode,
        ownerInstanceId: data.ownerInstanceId,
        leaseExpiresAt: data.leaseExpiresAt,
        firstPromptSent: data.firstPromptSent,
        createdAt: createdAt.toISOString(),
        updatedAt: now.toISOString(),
      };
      await local.save(record);
    } catch (err) {
      console.error(`[SessionDB] Failed to persist session to JSONL:`, err);
    }
  }
}

export async function deleteSessionFromDb(sessionId: string): Promise<void> {
  const driver = getDatabaseDriver();

  // Delete from DB
  if (driver !== "memory") {
    try {
      if (driver === "postgres") {
        const db = getPostgresDatabase();
        await new PgAcpSessionStore(db).delete(sessionId);
      } else {
        const { getSqliteDatabase } = await loadSqliteDatabaseModule();
        const db = getSqliteDatabase();
        await new SqliteAcpSessionStore(db).delete(sessionId);
      }
    } catch (err) {
      console.error(`[SessionDB] Failed to delete session from ${driver}:`, err);
    }
  }

  // Also delete local JSONL file — we need cwd to locate the file,
  // but we don't have it here. The JSONL file will be orphaned but harmless.
  // A future cleanup task can handle this.
}

export async function renameSessionInDb(sessionId: string, name: string): Promise<void> {
  const driver = getDatabaseDriver();

  if (driver !== "memory") {
    try {
      if (driver === "postgres") {
        const db = getPostgresDatabase();
        await new PgAcpSessionStore(db).rename(sessionId, name);
      } else {
        const { getSqliteDatabase } = await loadSqliteDatabaseModule();
        const db = getSqliteDatabase();
        await new SqliteAcpSessionStore(db).rename(sessionId, name);
      }
    } catch (err) {
      console.error(`[SessionDB] Failed to rename session in ${driver}:`, err);
    }
  }

  // Note: JSONL rename requires reading the session first to get cwd.
  // The metadata will be updated on next save() call.
}

export async function hydrateSessionsFromDb(): Promise<Array<{
  id: string;
  name?: string;
  cwd: string;
  branch?: string;
  workspaceId: string;
  routaAgentId?: string;
  providerSessionId?: string;
  provider?: string;
  role?: string;
  modeId?: string;
  model?: string;
  parentSessionId?: string;
  specialistId?: string;
  teamChainId?: TeamChainId;
  executionMode?: "embedded" | "runner";
  ownerInstanceId?: string;
  leaseExpiresAt?: string;
  createdAt: Date | null;
}>> {
  const driver = getDatabaseDriver();
  if (driver === "memory") return [];

  try {
    if (driver === "postgres") {
      const db = getPostgresDatabase();
      return await new PgAcpSessionStore(db).list();
    } else {
      const { getSqliteDatabase } = await loadSqliteDatabaseModule();
      const db = getSqliteDatabase();
      return await new SqliteAcpSessionStore(db).list();
    }
  } catch (err) {
    console.error(`[SessionDB] Failed to load sessions from ${driver}:`, err);
    return [];
  }
}

export async function loadSessionFromDb(sessionId: string): Promise<{
  id: string;
  name?: string;
  cwd: string;
  branch?: string;
  workspaceId: string;
  routaAgentId?: string;
  providerSessionId?: string;
  provider?: string;
  role?: string;
  modeId?: string;
  model?: string;
  firstPromptSent?: boolean;
  parentSessionId?: string;
  specialistId?: string;
  teamChainId?: TeamChainId;
  executionMode?: "embedded" | "runner";
  ownerInstanceId?: string;
  leaseExpiresAt?: string;
  createdAt: Date | null;
} | null> {
  const driver = getDatabaseDriver();
  if (driver === "memory") return null;

  try {
    if (driver === "postgres") {
      const db = getPostgresDatabase();
      return await new PgAcpSessionStore(db).get(sessionId) ?? null;
    }

    const { getSqliteDatabase } = await loadSqliteDatabaseModule();
    const db = getSqliteDatabase();
    return await new SqliteAcpSessionStore(db).get(sessionId) ?? null;
  } catch (err) {
    console.error(`[SessionDB] Failed to load session ${sessionId} from ${driver}:`, err);
    return null;
  }
}

export async function loadSessionFromLocalStorage(sessionId: string): Promise<{
  id: string;
  name?: string;
  cwd: string;
  branch?: string;
  workspaceId: string;
  routaAgentId?: string;
  providerSessionId?: string;
  provider?: string;
  role?: string;
  modeId?: string;
  model?: string;
  firstPromptSent?: boolean;
  parentSessionId?: string;
  specialistId?: string;
  teamChainId?: TeamChainId;
  executionMode?: "embedded" | "runner";
  ownerInstanceId?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
} | null> {
  return (await findLocalSessionRecord(sessionId)) ?? null;
}

export async function updateSessionExecutionBindingInDb(
  sessionId: string,
  binding: {
    executionMode?: "embedded" | "runner";
    ownerInstanceId?: string;
    leaseExpiresAt?: string;
  }
): Promise<void> {
  const driver = getDatabaseDriver();
  if (driver === "memory") return;

  // Targeted update of the execution-binding columns only; durable fields
  // (routa_agent_id, history, firstPromptSent, metadata) are never rewritten.
  await updateSessionRuntimeBindingInDb(sessionId, binding);
}

/**
 * Structured outcome of a runtime-lease acquisition attempt.
 *
 * A bare boolean used to collapse "another instance holds an active lease",
 * "no durable row exists (JSONL-only session)", and "the database is
 * unreachable" into one `false` — and recovery then misread DB outages as
 * JSONL-only sessions and started runtimes anyway. With the structured
 * result every caller is forced to branch:
 *
 * - `acquired`      — this instance now owns the lease (CAS succeeded).
 * - `already_owned` — this instance already held the active lease (refresh).
 * - `conflict`      — a successful CAS refusal: another instance holds the
 *                     active lease; `ownerInstanceId`/`leaseExpiresAt` carry
 *                     the holder so callers can surface a retryable error.
 * - `missing`       — a SUCCESSFUL query found no durable row: the session
 *                     exists only as JSONL. Only successful queries may ever
 *                     produce `missing`.
 * - `unavailable`   — any DB failure. Never conflated with `missing`;
 *                     ownership could not be verified, so callers must
 *                     fail closed (no runtime start, no dispatch).
 */
export type LeaseAcquisitionOutcome =
  | "acquired"
  | "already_owned"
  | "conflict"
  | "missing"
  | "unavailable";

export interface LeaseAcquisitionResult {
  outcome: LeaseAcquisitionOutcome;
  /** Current lease holder when `outcome` is `conflict`. */
  ownerInstanceId?: string;
  leaseExpiresAt?: string;
}

/**
 * Acquire (or refresh) a session's runtime lease in the DB via a single
 * conditional UPDATE (compare-and-swap) — never read-then-save — and report
 * a structured {@link LeaseAcquisitionResult}.
 *
 * The CAS is authoritative. Surrounding reads only classify a refusal:
 * a pre-read detects an already-active own lease (`already_owned` vs a fresh
 * `acquired`); a post-read distinguishes `missing` (no row — successful query
 * only) from `conflict` (a row another instance actively owns). Any storage
 * error at any point yields `unavailable` — never `missing`, never a thrown
 * exception — so callers fail closed during DB outages.
 *
 * The memory driver is single-process, so acquisition always succeeds there.
 */
export async function acquireSessionLeaseInDb(
  sessionId: string,
  acquire: {
    ownerInstanceId: string;
    leaseExpiresAt: string;
    executionMode?: "embedded" | "runner";
  },
): Promise<LeaseAcquisitionResult> {
  const driver = getDatabaseDriver();
  if (driver === "memory") return { outcome: "acquired" };

  try {
    const store = driver === "postgres"
      ? new PgAcpSessionStore(getPostgresDatabase())
      : new SqliteAcpSessionStore((await loadSqliteDatabaseModule()).getSqliteDatabase());

    // Diagnostic pre-read: if this instance already holds an ACTIVE lease the
    // CAS below is a refresh, reported as `already_owned` rather than a fresh
    // takeover. A failed pre-read is itself a storage error → fail closed.
    const prior = await store.get(sessionId);

    const acquired = await store.tryAcquireExpiredLease(sessionId, acquire);
    if (acquired) {
      const wasOwnedByThisInstance = !!prior
        && prior.ownerInstanceId === acquire.ownerInstanceId
        && typeof prior.leaseExpiresAt === "string"
        && Date.parse(prior.leaseExpiresAt) > Date.now();
      return { outcome: wasOwnedByThisInstance ? "already_owned" : "acquired" };
    }

    // CAS refused: classify via a second, successful read. No row means the
    // session exists only as JSONL (`missing`); a row means the race was won
    // by another instance's active lease (`conflict`).
    const current = await store.get(sessionId);
    if (!current) return { outcome: "missing" };
    return {
      outcome: "conflict",
      ownerInstanceId: current.ownerInstanceId,
      leaseExpiresAt: current.leaseExpiresAt,
    };
  } catch (err) {
    console.error(`[SessionDB] Failed to acquire session lease in ${driver}:`, err);
    return { outcome: "unavailable" };
  }
}

/**
 * Atomically acquire (or refresh) a session's runtime lease in the DB via a
 * single conditional UPDATE (compare-and-swap) — never read-then-save.
 *
 * Boolean facade over {@link acquireSessionLeaseInDb} kept ONLY for
 * fire-and-forget refresh callers (attach/SSE paths) that treat every
 * non-acquisition the same way: skip the refresh, retry on the next beat.
 * Recovery acquisition and prompt dispatch MUST use the structured result
 * instead — collapsing its five outcomes into a boolean is exactly the
 * fail-open hole that let runtimes start during DB outages.
 */
export async function tryAcquireSessionLeaseInDb(
  sessionId: string,
  acquire: {
    ownerInstanceId: string;
    leaseExpiresAt: string;
    executionMode?: "embedded" | "runner";
  },
): Promise<boolean> {
  const result = await acquireSessionLeaseInDb(sessionId, acquire);
  return result.outcome === "acquired" || result.outcome === "already_owned";
}

/**
 * Targeted runtime-binding update for recovery paths.
 *
 * Updates ONLY the provider-native session ID and execution binding columns,
 * leaving durable fields (routa_agent_id, message history, firstPromptSent,
 * team metadata) untouched. Returns true when a persisted row was updated;
 * false means the session is not in the DB and the caller should persist a
 * complete record instead.
 *
 * `providerSessionId` semantics: a string persists that native ID; `null`
 * explicitly clears the column (a stale/polluted native ID after a Claude
 * context rebuild); `undefined` leaves the column untouched.
 */
export async function updateSessionRuntimeBindingInDb(
  sessionId: string,
  update: {
    providerSessionId?: string | null;
    executionMode?: "embedded" | "runner";
    ownerInstanceId?: string;
    leaseExpiresAt?: string;
  }
): Promise<boolean> {
  const driver = getDatabaseDriver();
  if (driver === "memory") return false;

  try {
    if (driver === "postgres") {
      const db = getPostgresDatabase();
      return await new PgAcpSessionStore(db).updateRuntimeBinding(sessionId, update);
    }

    const { getSqliteDatabase } = await loadSqliteDatabaseModule();
    const db = getSqliteDatabase();
    return await new SqliteAcpSessionStore(db).updateRuntimeBinding(sessionId, update);
  } catch (err) {
    console.error(`[SessionDB] Failed to update runtime binding in ${driver}:`, err);
    return false;
  }
}

/**
 * Persist a provider-native session ID captured directly from the provider
 * (Claude CLI `system/init.session_id`, Claude SDK resume/init, or an ACP
 * `session/new`/`session/load` response). This is the ONLY legitimate source
 * of `provider_session_id` values — it must never be derived from the Routa
 * Session ID or `routa_agent_id`.
 *
 * The dynamic import avoids a runtime cycle (http-session-store imports this
 * module). Persistence failures are logged, not thrown: the in-memory binding
 * is live and the ID will be re-captured/re-persisted on the next init.
 */
export async function persistCapturedProviderSessionId(
  sessionId: string,
  capturedProviderSessionId: string,
): Promise<void> {
  if (!capturedProviderSessionId || capturedProviderSessionId === sessionId) {
    // Never persist a runtime handle or the Routa Session ID as the native ID.
    return;
  }
  try {
    const { getHttpSessionStore } = await import("@/core/acp/http-session-store");
    getHttpSessionStore().setProviderSessionId(sessionId, capturedProviderSessionId);
  } catch (err) {
    console.warn(`[SessionDB] Failed to record captured provider session ID in memory for ${sessionId}:`, err);
  }
  try {
    await updateSessionRuntimeBindingInDb(sessionId, {
      providerSessionId: capturedProviderSessionId,
    });
  } catch (err) {
    console.warn(`[SessionDB] Failed to persist captured provider session ID for ${sessionId}:`, err);
  }
}

/**
 * Verify that a provider-native session ID is present in the durable database.
 *
 * Runtime finalization must not trust the in-memory session record here: the
 * provider callback can arrive before the initial session row exists, or a
 * transient database failure can leave memory ahead of durable storage.
 * Treat every lookup failure as not durable so automatic release fails closed.
 */
export async function isProviderSessionIdDurable(
  sessionId: string,
  providerSessionId: string,
): Promise<boolean> {
  if (!providerSessionId || providerSessionId === sessionId) return false;

  const driver = getDatabaseDriver();
  if (driver === "memory") return false;

  try {
    const session = driver === "postgres"
      ? await new PgAcpSessionStore(getPostgresDatabase()).get(sessionId)
      : await new SqliteAcpSessionStore(
          (await loadSqliteDatabaseModule()).getSqliteDatabase(),
        ).get(sessionId);
    return session?.providerSessionId === providerSessionId;
  } catch (err) {
    console.warn(
      `[SessionDB] Could not verify provider session ID durability for ${sessionId}:`,
      err,
    );
    return false;
  }
}

export async function saveHistoryToDb(
  sessionId: string,
  history: import("@/core/acp/http-session-store").SessionUpdateNotification[]
): Promise<void> {
  const driver = getDatabaseDriver();
  const normalizedHistory = compactSessionHistoryForPersistence(normalizeSessionHistory(history));
  const firstPromptSent = hasUserMessageInHistory(normalizedHistory);

  // 1. Save full history snapshot to DB
  if (driver !== "memory") {
    try {
      if (driver === "postgres") {
        const db = getPostgresDatabase();
        const pgStore = new PgAcpSessionStore(db);
        const session = await pgStore.get(sessionId);
        if (!session) return;
        await pgStore.save({
          ...session,
          firstPromptSent: session.firstPromptSent || firstPromptSent,
          messageHistory: normalizedHistory,
          updatedAt: new Date(),
        });
      } else {
        const { getSqliteDatabase } = await loadSqliteDatabaseModule();
        const db = getSqliteDatabase();
        const sqliteStore = new SqliteAcpSessionStore(db);
        const session = await sqliteStore.get(sessionId);
        if (!session) return;
        await sqliteStore.save({
          ...session,
          firstPromptSent: session.firstPromptSent || firstPromptSent,
          messageHistory: normalizedHistory,
          updatedAt: new Date(),
        });
      }
    } catch (err) {
      console.error(`[SessionDB] Failed to save history to ${driver}:`, err);
    }
  }

  // 2. Also append to local JSONL (non-serverless only)
  // We need the session's cwd to locate the JSONL file.
  // Try in-memory store first; fall back to SQLite session record so writes
  // still succeed after a server restart when the in-memory store is empty.
  if (!isServerless()) {
    try {
      let cwd: string | undefined;

      // Primary: in-memory store (fast, always available during active session)
      const { getHttpSessionStore } = await import("@/core/acp/http-session-store");
      const memStore = getHttpSessionStore();
      cwd = memStore.getSession(sessionId)?.cwd;

      // Fallback: SQLite session record (available after server restart)
      if (!cwd && driver === "sqlite") {
        try {
          const { getSqliteDatabase } = await loadSqliteDatabaseModule();
          const db = getSqliteDatabase();
          const sqliteSession = await new SqliteAcpSessionStore(db).get(sessionId);
          cwd = sqliteSession?.cwd;
        } catch {
          // ignore — cwd stays undefined
        }
      }

      if (cwd) {
        const local = new LocalSessionProvider(cwd);
        await local.replaceHistory(sessionId, toJsonlHistoryEntries(sessionId, normalizedHistory));
      }
    } catch {
      // Non-fatal — JSONL write is best-effort
    }
  }
}

export async function appendSessionNotificationEvent(
  sessionId: string,
  notification: import("@/core/acp/http-session-store").SessionUpdateNotification,
  cwdOverride?: string,
): Promise<void> {
  const driver = getDatabaseDriver();
  const persistedNotification = compactSessionNotificationForPersistence(notification);

  if (driver !== "memory") {
    try {
      if (driver === "postgres") {
        const db = getPostgresDatabase();
        await new PgAcpSessionStore(db).appendHistory(sessionId, persistedNotification);
      } else {
        const { getSqliteDatabase } = await loadSqliteDatabaseModule();
        const db = getSqliteDatabase();
        await new SqliteAcpSessionStore(db).appendHistory(sessionId, persistedNotification);
      }
    } catch {
      // Non-fatal — DB append is best-effort
    }
  }

  if (isServerless()) return;

  try {
    let cwd = cwdOverride;

    if (!cwd) {
      const { getHttpSessionStore } = await import("@/core/acp/http-session-store");
      cwd = getHttpSessionStore().getSession(sessionId)?.cwd;
    }

    if (!cwd && driver === "sqlite") {
      try {
        const { getSqliteDatabase } = await loadSqliteDatabaseModule();
        const db = getSqliteDatabase();
        cwd = (await new SqliteAcpSessionStore(db).get(sessionId))?.cwd;
      } catch {
        // ignore — cwd stays undefined
      }
    }

    if (!cwd) return;

    const local = new LocalSessionProvider(cwd);
    await local.appendMessage(sessionId, toJsonlHistoryEntry(sessionId, persistedNotification));
  } catch {
    // Non-fatal — local event log append is best-effort
  }
}

/**
 * Structured outcome of the durable once-append. A bare boolean used to
 * collapse "true duplicate", "session row missing", and "DB write failed"
 * into one `false`, and callers misread all three as "already delivered".
 * Storage failures are reported as `unavailable` (never thrown here) so every
 * caller is forced to branch on the outcome; only `duplicate` may be treated
 * as an already-acknowledged delivery.
 */
export type AppendSessionEventOnceOutcome =
  | { status: "appended" }
  | { status: "duplicate" }
  | { status: "session_not_found" }
  | { status: "unavailable"; error: string };

/**
 * Idempotent, durable notification append keyed by the notification's
 * `eventId` — the persistent acknowledgement behind prompt/child-report
 * delivery retries ("appendHistoryOnce").
 *
 * Returns a structured outcome (see {@link AppendSessionEventOnceOutcome}).
 * The DB check-and-append happens in one store transaction; the JSONL mirror
 * is only written when the durable append succeeded, so a replayed retry never
 * duplicates the local event log either.
 */
export async function appendSessionNotificationEventOnce(
  sessionId: string,
  notification: import("@/core/acp/http-session-store").SessionUpdateNotification,
): Promise<AppendSessionEventOnceOutcome> {
  const eventId = notification.eventId;
  if (typeof eventId !== "string" || eventId.length === 0) {
    // Without an event ID there is nothing to deduplicate on; fall back to a
    // plain append so callers never silently lose the event.
    await appendSessionNotificationEvent(sessionId, notification);
    return { status: "appended" };
  }

  const driver = getDatabaseDriver();
  const persistedNotification = compactSessionNotificationForPersistence({
    ...notification,
    eventId,
  });
  let outcome: AppendSessionEventOnceOutcome;

  if (driver === "memory") {
    // Development/single-process driver: the in-memory history is the source
    // of truth. Deduplicate against it directly.
    try {
      const { getHttpSessionStore } = await import("@/core/acp/http-session-store");
      const store = getHttpSessionStore();
      if (!store.getSession(sessionId)) {
        outcome = { status: "session_not_found" };
      } else if (store.getHistory(sessionId).some((entry) => entry.eventId === eventId)) {
        outcome = { status: "duplicate" };
      } else {
        store.pushNotificationToHistory(sessionId, { ...persistedNotification, eventId });
        outcome = { status: "appended" };
      }
    } catch (err) {
      console.error("[SessionDB] Failed to append-once in memory history:", err);
      outcome = {
        status: "unavailable",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  } else {
    try {
      if (driver === "postgres") {
        const db = getPostgresDatabase();
        outcome = { status: await new PgAcpSessionStore(db).appendHistoryOnce(sessionId, eventId, persistedNotification) };
      } else {
        const { getSqliteDatabase } = await loadSqliteDatabaseModule();
        const db = getSqliteDatabase();
        outcome = { status: await new SqliteAcpSessionStore(db).appendHistoryOnce(sessionId, eventId, persistedNotification) };
      }
    } catch (err) {
      console.error(`[SessionDB] Failed to append-once event ${eventId} to ${driver}:`, err);
      outcome = {
        status: "unavailable",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (outcome.status !== "appended" || isServerless()) return outcome;

  // Mirror to the local JSONL only when the durable append succeeded.
  try {
    let cwd: string | undefined;
    const { getHttpSessionStore } = await import("@/core/acp/http-session-store");
    cwd = getHttpSessionStore().getSession(sessionId)?.cwd;

    if (!cwd && driver === "sqlite") {
      try {
        const { getSqliteDatabase } = await loadSqliteDatabaseModule();
        const db = getSqliteDatabase();
        cwd = (await new SqliteAcpSessionStore(db).get(sessionId))?.cwd;
      } catch {
        // ignore — cwd stays undefined
      }
    }

    if (cwd) {
      const local = new LocalSessionProvider(cwd);
      await local.appendMessage(sessionId, toJsonlHistoryEntry(sessionId, persistedNotification));
    }
  } catch {
    // Non-fatal — local event log append is best-effort
  }

  return outcome;
}

/**
 * Whether an event with the given ID is durably recorded in the session's
 * history. Errors resolve to false so callers fail toward at-least-once
 * delivery (re-dispatch) rather than falsely reporting "already delivered".
 */
export async function hasSessionHistoryEventInDb(
  sessionId: string,
  eventId: string,
): Promise<boolean> {
  const driver = getDatabaseDriver();

  try {
    if (driver === "memory") {
      const { getHttpSessionStore } = await import("@/core/acp/http-session-store");
      return getHttpSessionStore().getHistory(sessionId).some((entry) => entry.eventId === eventId);
    }

    if (driver === "postgres") {
      const db = getPostgresDatabase();
      return await new PgAcpSessionStore(db).hasHistoryEvent(sessionId, eventId);
    }

    const { getSqliteDatabase } = await loadSqliteDatabaseModule();
    const db = getSqliteDatabase();
    return await new SqliteAcpSessionStore(db).hasHistoryEvent(sessionId, eventId);
  } catch (err) {
    console.error(`[SessionDB] Failed to check history event ${eventId} in ${driver}:`, err);
    return false;
  }
}

export async function loadHistorySinceEventIdFromDb(
  sessionId: string,
  lastEventId: string,
  cwdOverride?: string,
): Promise<import("@/core/acp/http-session-store").SessionUpdateNotification[]> {
  const driver = getDatabaseDriver();

  try {
    if (driver === "postgres") {
      const db = getPostgresDatabase();
      const history = await new PgAcpSessionStore(db).getHistory(sessionId, { afterEventId: lastEventId });
      if (history.length > 0) return history as import("@/core/acp/http-session-store").SessionUpdateNotification[];
    } else if (driver === "sqlite") {
      const { getSqliteDatabase } = await loadSqliteDatabaseModule();
      const db = getSqliteDatabase();
      const history = await new SqliteAcpSessionStore(db).getHistory(sessionId, { afterEventId: lastEventId });
      if (history.length > 0) return history as import("@/core/acp/http-session-store").SessionUpdateNotification[];
    } else if (driver === "memory") {
      const { getHttpSessionStore } = await import("@/core/acp/http-session-store");
      return getHttpSessionStore().getHistorySinceEventId(sessionId, lastEventId);
    }
  } catch {
    // Fall through to mixed-source fallback below.
  }

  const history = await loadHistoryFromDb(sessionId, cwdOverride);
  const index = history.findIndex((entry) => entry.eventId === lastEventId);
  if (index >= 0) return history.slice(index + 1);

  const { getHttpSessionStore } = await import("@/core/acp/http-session-store");
  return getHttpSessionStore().getHistorySinceEventId(sessionId, lastEventId);
}

export async function loadHistoryFromDb(
  sessionId: string,
  cwdOverride?: string,
): Promise<import("@/core/acp/http-session-store").SessionUpdateNotification[]> {
  const driver = getDatabaseDriver();
  if (driver === "memory") return [];

  let dbHistory: import("@/core/acp/http-session-store").SessionUpdateNotification[] = [];
  let sessionCwd: string | undefined = cwdOverride;

  try {
    if (driver === "postgres") {
      const db = getPostgresDatabase();
      dbHistory = normalizeSessionHistory(
        (await new PgAcpSessionStore(db).getHistory(sessionId)) as import("@/core/acp/http-session-store").SessionUpdateNotification[]
      );
    } else {
      const { getSqliteDatabase } = await loadSqliteDatabaseModule();
      const db = getSqliteDatabase();
      const sqliteStore = new SqliteAcpSessionStore(db);
      dbHistory = normalizeSessionHistory(
        (await sqliteStore.getHistory(sessionId)) as import("@/core/acp/http-session-store").SessionUpdateNotification[]
      );
      // Also capture cwd from SQLite so we can try the JSONL fallback below
      if (!sessionCwd && !isServerless()) {
        const session = await sqliteStore.get(sessionId);
        sessionCwd = session?.cwd;
      }
    }
  } catch (err) {
    console.error(`[SessionDB] Failed to load history from ${driver}:`, err);
  }

  // For non-serverless (localhost / Tauri): also try the local JSONL file.
  // JSONL is an append-only log written alongside the DB, so it may contain
  // more recent entries when the process was interrupted before the buffer flushed.
  if (!isServerless() && sessionCwd) {
    try {
      const local = new LocalSessionProvider(sessionCwd);
      const rawEntries = await local.getHistory(sessionId);
      // Each entry is a SessionJsonlEntry wrapper: { uuid, type, message, sessionId, timestamp }
      const jsonlHistory = normalizeSessionHistory(rawEntries
        .map((e) => (e as Record<string, unknown>).message)
        .filter(Boolean) as import("@/core/acp/http-session-store").SessionUpdateNotification[]);

      if (jsonlHistory.length > dbHistory.length) {
        console.log(`[SessionDB] JSONL has more history (${jsonlHistory.length}) than DB (${dbHistory.length}) for session ${sessionId}, using JSONL`);
        return jsonlHistory;
      }
    } catch {
      // Non-fatal — fall through to DB history
    }
  }

  return dbHistory;
}

function toJsonlHistoryEntries(
  sessionId: string,
  history: import("@/core/acp/http-session-store").SessionUpdateNotification[]
): SessionJsonlEntry[] {
  return history.map((entry, index) => toJsonlHistoryEntry(sessionId, entry, index));
}

function toJsonlHistoryEntry(
  sessionId: string,
  entry: import("@/core/acp/http-session-store").SessionUpdateNotification,
  index = 0,
): SessionJsonlEntry {
  const raw = entry as Record<string, unknown>;
  return {
    uuid: raw.uuid as string ?? `${sessionId}-${index}`,
    type: raw.type as string ?? ((raw.update as Record<string, unknown> | undefined)?.sessionUpdate as string | undefined) ?? "notification",
    message: entry,
    sessionId,
    timestamp: new Date().toISOString(),
  };
}

export function normalizeSessionHistory<T>(history: T[]): T[] {
  if (history.length < 2) return history;

  const serialized = history.map((entry) => JSON.stringify(entry));

  for (let blockSize = 1; blockSize <= Math.floor(history.length / 2); blockSize++) {
    if (history.length % blockSize !== 0) continue;
    const repeats = history.length / blockSize;
    if (repeats < 2) continue;

    let allBlocksMatch = true;
    for (let i = blockSize; i < history.length; i++) {
      if (serialized[i] !== serialized[i % blockSize]) {
        allBlocksMatch = false;
        break;
      }
    }

    if (!allBlocksMatch) continue;

    const block = history.slice(0, blockSize);
    const hasConversationPayload = block.some((entry) => {
      const text = JSON.stringify(entry);
      return text.includes("user_message") || text.includes("agent_message") || text.includes("tool_call");
    });

    if (hasConversationPayload) {
      return block;
    }
  }

  return history;
}

export function hasUserMessageInHistory(
  history: import("@/core/acp/http-session-store").SessionUpdateNotification[],
): boolean {
  return history.some((entry) => {
    const update = (entry as { update?: { sessionUpdate?: string } }).update;
    return update?.sessionUpdate === "user_message";
  });
}
