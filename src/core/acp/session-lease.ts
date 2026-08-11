/**
 * Session runtime lease refresh.
 *
 * Embedded provider runtimes are owned by exactly one Routa instance. The
 * ownership is recorded as a lease (ownerInstanceId + leaseExpiresAt) on the
 * durable Routa Session row. Active sessions refresh their lease on use
 * (prompt acceptance, SSE attach) and periodically while a client stream is
 * attached, using the same atomic conditional UPDATE (compare-and-swap) as
 * recovery acquisition — a refresh can therefore never steal ownership from
 * another instance and never touches durable fields.
 */

import {
  buildAcpLeaseExpiresAt,
  getAcpInstanceId,
  getSessionLeaseRefreshMs,
  refreshExecutionBinding,
} from "@/core/acp/execution-backend";
import {
  acquireSessionLeaseInDb,
  tryAcquireSessionLeaseInDb,
} from "@/core/acp/session-db-persister";
import type { getHttpSessionStore, RoutaSessionRecord } from "@/core/acp/http-session-store";

export { getSessionLeaseRefreshMs };

/**
 * Refresh the lease of an embedded session owned by this instance.
 *
 * Updates the in-memory record and persists the refreshed lease with an
 * atomic CAS (`tryAcquireExpiredLease`): the DB write only succeeds while
 * this instance still owns the lease (or the lease expired), so concurrent
 * instances never clobber each other's binding. Fire-and-forget by design —
 * a failed refresh only means the next refresh retries; the in-memory
 * runtime is unaffected.
 */
export function refreshEmbeddedSessionLease(
  store: ReturnType<typeof getHttpSessionStore>,
  session: RoutaSessionRecord | undefined,
): void {
  if (!session || session.executionMode !== "embedded") {
    return;
  }

  const refreshed = refreshExecutionBinding(session);
  store.upsertSession(refreshed);
  void tryAcquireSessionLeaseInDb(session.sessionId, {
    executionMode: "embedded",
    ownerInstanceId: refreshed.ownerInstanceId ?? getAcpInstanceId(),
    leaseExpiresAt: refreshed.leaseExpiresAt ?? buildAcpLeaseExpiresAt(),
  });
}

/**
 * Result of the checked lease refresh performed when a prompt is accepted.
 *
 * - `owned`       — this instance verifiably holds the lease (acquired or
 *                   refreshed); the in-memory record was updated. Dispatch
 *                   may proceed.
 * - `no_record`   — no durable lease applies (session row missing — JSONL-only
 *                   determined by a SUCCESSFUL query — or the session is not
 *                   embedded). Dispatch may proceed.
 * - `lost`        — the CAS proved another instance now holds the active
 *                   lease; `ownerInstanceId`/`leaseExpiresAt` identify the
 *                   holder. Dispatch must stop and the orphaned local runtime
 *                   must be isolated.
 * - `unavailable` — the lease could not be verified (DB failure). Dispatch
 *                   must stop fail-closed, but the runtime is kept: the loss
 *                   is unproven and killing it would destroy work on a
 *                   transient outage.
 */
export type EmbeddedLeaseDispatchStatus = "owned" | "no_record" | "lost" | "unavailable";

export interface EmbeddedLeaseDispatchCheck {
  status: EmbeddedLeaseDispatchStatus;
  /** Current lease holder when `status` is `lost`. */
  ownerInstanceId?: string;
  leaseExpiresAt?: string;
}

/**
 * Checked lease refresh for prompt dispatch (fail-closed heartbeat).
 *
 * Unlike {@link refreshEmbeddedSessionLease} (fire-and-forget for attach/SSE
 * paths), prompt acceptance must not dispatch while the runtime's ownership
 * is lost or unverifiable: dispatching to a runtime another instance owns can
 * fork the provider conversation, and dispatching while ownership is unknown
 * hides a split-brain. The structured acquisition outcome is therefore
 * awaited and surfaced to the caller:
 *
 * - acquired / already_owned → refresh the in-memory record, `owned`;
 * - missing                  → `no_record` (JSONL-only, safe to proceed);
 * - conflict                 → `lost` with the holder info;
 * - unavailable              → `unavailable` (never downgraded to no_record).
 *
 * Non-embedded sessions (runner mode, or no session record) carry no lease to
 * verify and report `no_record`.
 */
export async function checkEmbeddedSessionLeaseForDispatch(
  store: ReturnType<typeof getHttpSessionStore>,
  session: RoutaSessionRecord | undefined,
): Promise<EmbeddedLeaseDispatchCheck> {
  if (!session || session.executionMode !== "embedded") {
    return { status: "no_record" };
  }

  const refreshed = refreshExecutionBinding(session);
  const acquisition = await acquireSessionLeaseInDb(session.sessionId, {
    executionMode: "embedded",
    ownerInstanceId: refreshed.ownerInstanceId ?? getAcpInstanceId(),
    leaseExpiresAt: refreshed.leaseExpiresAt ?? buildAcpLeaseExpiresAt(),
  });

  switch (acquisition.outcome) {
    case "acquired":
    case "already_owned":
      store.upsertSession(refreshed);
      return { status: "owned" };
    case "missing":
      return { status: "no_record" };
    case "conflict":
      return {
        status: "lost",
        ownerInstanceId: acquisition.ownerInstanceId,
        leaseExpiresAt: acquisition.leaseExpiresAt,
      };
    case "unavailable":
    default:
      return { status: "unavailable" };
  }
}
