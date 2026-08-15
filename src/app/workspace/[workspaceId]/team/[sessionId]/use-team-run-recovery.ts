/**
 * Team Run bootstrap recovery.
 *
 * Opening an existing Team Run must choose EXACTLY ONE attach path:
 *
 * - `continuityStatus=active` → `selectSession` (SSE attach only — the local
 *   runtime already exists and must not be recreated), or
 * - `restorable`/`interrupted`/`stale` → `resumeSession` (`session/load` →
 *   `ensureSessionRuntime` recovery, which attaches SSE itself — the page
 *   must not also call `selectSession` for the same attempt).
 *
 * A page-context single-flight guard keyed by `workspaceId:sessionId` keeps
 * rerenders from starting concurrent Resume calls; it clears when the route
 * context changes or the attempt settles. A retryable ownership conflict is
 * not terminal: the lease hint (structured `retryAfterMs` / `leaseExpiresAt`,
 * parsed by the ACP client) schedules a wait after which recovery re-enters
 * `session/load` — probing SSE alone never acquires a lease or restores a
 * provider runtime. Non-retryable failures surface the localized error with
 * a manual Retry and preserve the pending prompt.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { computeRecoveryRetryDelayMs } from "@/client/acp-client";

import type { SessionInfo } from "../../types";

export interface UseTeamRunRecoveryOptions {
  workspaceId: string;
  sessionId: string;
  isResolved: boolean;
  acpConnected: boolean;
  /** Session id the ACP client is currently attached to (null when detached). */
  attachedSessionId: string | null;
  session: SessionInfo | null;
  selectSession: (sessionId: string) => void;
  resumeSession: (
    sessionId: string,
    cwd?: string,
    options?: { throwOnError?: boolean },
  ) => Promise<unknown>;
  /** Map a recovery failure to the user-facing localized message. */
  localizeRecoveryError: (err: unknown) => string;
}

export interface UseTeamRunRecoveryResult {
  /** Localized recovery error from the last failed attempt, if any. */
  recoveryError: string | null;
  /** Manual retry: re-enters session/load for the current page context. */
  retryRecovery: () => void;
}

export function useTeamRunRecovery({
  workspaceId,
  sessionId,
  isResolved,
  acpConnected,
  attachedSessionId,
  session,
  selectSession,
  resumeSession,
  localizeRecoveryError,
}: UseTeamRunRecoveryOptions): UseTeamRunRecoveryResult {
  const recoveryInFlightRef = useRef<string | null>(null);
  const recoverySettledRef = useRef<{ contextKey: string; token: number } | null>(null);
  const recoveryRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [recoveryRetryToken, setRecoveryRetryToken] = useState(0);
  // Failed-attempt record, scoped to its page context. The displayed error is
  // DERIVED (below), so a context switch or a successful attach hides a stale
  // banner without any synchronous setState inside an effect body.
  const [recoveryAttemptError, setRecoveryAttemptError] = useState<{
    contextKey: string;
    message: string;
  } | null>(null);

  const clearRecoveryRetryTimer = useCallback(() => {
    if (recoveryRetryTimerRef.current !== null) {
      clearTimeout(recoveryRetryTimerRef.current);
      recoveryRetryTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    // New page context: drop any in-flight or settled recovery attempt and
    // its retry timer so the new run bootstraps from a clean state. A stale
    // error banner is filtered out by the derived recoveryError instead.
    recoveryInFlightRef.current = null;
    recoverySettledRef.current = null;
    clearRecoveryRetryTimer();
  }, [sessionId, workspaceId, clearRecoveryRetryTimer]);

  useEffect(() => {
    // The ACP client is no longer attached: a pending lease-wait retry must
    // not fire while disconnected.
    if (!acpConnected) {
      clearRecoveryRetryTimer();
    }
  }, [acpConnected, clearRecoveryRetryTimer]);

  useEffect(() => () => clearRecoveryRetryTimer(), [clearRecoveryRetryTimer]);

  useEffect(() => {
    if (!isResolved || !acpConnected || !session || session.sessionId !== sessionId || sessionId === "__placeholder__") {
      return;
    }
    const contextKey = `${workspaceId}:${sessionId}`;
    if (attachedSessionId === sessionId) {
      // Attached (select or a successful Resume): the derived recoveryError
      // hides any stale banner.
      return;
    }

    const continuityStatus = session.continuityStatus ?? "active";
    if (continuityStatus === "active") {
      selectSession(sessionId);
      return;
    }

    if (recoveryInFlightRef.current === contextKey) return;
    const settledAttempt = recoverySettledRef.current;
    if (settledAttempt && settledAttempt.contextKey === contextKey && settledAttempt.token === recoveryRetryToken) {
      // The attempt already settled for this context and retry token. Successful
      // loads attach SSE (attachedSessionId catches up); failed ones wait for
      // the lease-hint retry timer or a manual Retry. Rerenders must not start
      // another Resume call on their own.
      return;
    }

    recoveryInFlightRef.current = contextKey;
    void resumeSession(sessionId, session.cwd, { throwOnError: true })
      .then(() => {
        recoverySettledRef.current = { contextKey, token: recoveryRetryToken };
        setRecoveryAttemptError(null);
      })
      .catch((err) => {
        recoverySettledRef.current = { contextKey, token: recoveryRetryToken };
        setRecoveryAttemptError({ contextKey, message: localizeRecoveryError(err) });
        const retryDelayMs = computeRecoveryRetryDelayMs(err);
        if (retryDelayMs !== null) {
          clearRecoveryRetryTimer();
          recoveryRetryTimerRef.current = setTimeout(() => {
            recoveryRetryTimerRef.current = null;
            setRecoveryRetryToken((current) => current + 1);
          }, retryDelayMs);
        }
      })
      .finally(() => {
        if (recoveryInFlightRef.current === contextKey) {
          recoveryInFlightRef.current = null;
        }
      });
  }, [attachedSessionId, acpConnected, isResolved, resumeSession, selectSession, session, sessionId, workspaceId, recoveryRetryToken, localizeRecoveryError, clearRecoveryRetryTimer]);

  /**
   * Manual recovery retry: bumping the token re-enters the bootstrap effect,
   * which calls `session/load` again. The pending prompt payload is untouched,
   * so the first prompt keeps its text, transfer ID, and delivery identity.
   */
  const retryRecovery = useCallback(() => {
    clearRecoveryRetryTimer();
    setRecoveryRetryToken((current) => current + 1);
  }, [clearRecoveryRetryTimer]);

  const contextKey = `${workspaceId}:${sessionId}`;
  const recoveryError =
    attachedSessionId !== sessionId &&
    recoveryAttemptError !== null &&
    recoveryAttemptError.contextKey === contextKey
      ? recoveryAttemptError.message
      : null;

  return { recoveryError, retryRecovery };
}
