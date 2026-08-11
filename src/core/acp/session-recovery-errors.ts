/**
 * Structured JSON-RPC error envelope for runtime recovery.
 *
 * Web and Rust return the same JSON-RPC codes and `data.reason` values.
 * Human-readable messages may differ, but client behavior must depend on the
 * structured fields.
 *
 * See docs/design-docs/team-session-runtime-recovery.md
 * ("Existing public ACP API").
 */

import type { AcpExecutionBinding } from "@/core/acp/execution-backend";

export type RuntimeRecoveryErrorReason =
  | "session_not_found"
  | "runtime_owned"
  | "recovery_unavailable"
  | "recovery_failed"
  | "workspace_unavailable"
  | "provider_configuration_missing";

export interface RuntimeRecoveryErrorData {
  reason: RuntimeRecoveryErrorReason;
  retryable: boolean;
  ownerInstanceId?: string;
  leaseExpiresAt?: string;
  retryAfterMs?: number;
  [key: string]: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

/** Stable JSON-RPC codes shared by the Web and Rust backends. */
export const RECOVERY_JSON_RPC_CODES = {
  invalidParams: -32602,
  sessionNotFound: -32004,
  runtimeOwned: -32010,
  recoveryUnavailable: -32011,
  recoveryFailed: -32012,
  recoveryConfigurationUnavailable: -32013,
} as const;

const RETRYABLE_REASONS: ReadonlySet<RuntimeRecoveryErrorReason> = new Set([
  "runtime_owned",
]);

export function isRetryableRecoveryReason(reason: RuntimeRecoveryErrorReason): boolean {
  return RETRYABLE_REASONS.has(reason);
}

/** Milliseconds until the lease expires; undefined when it cannot be derived. */
export function computeLeaseRetryAfterMs(
  leaseExpiresAt?: string,
  now: number = Date.now(),
): number | undefined {
  if (!leaseExpiresAt) return undefined;
  const expiresAt = Date.parse(leaseExpiresAt);
  if (!Number.isFinite(expiresAt)) return undefined;
  return Math.max(0, expiresAt - now);
}

export function buildRecoveryErrorData(
  reason: RuntimeRecoveryErrorReason,
  extras: Partial<Omit<RuntimeRecoveryErrorData, "reason" | "retryable">> = {},
): RuntimeRecoveryErrorData {
  return {
    reason,
    retryable: isRetryableRecoveryReason(reason),
    ...extras,
  };
}

/** Structured error for a session owned by another instance (active or expired lease). */
export function buildRuntimeOwnedError(
  message: string,
  binding: AcpExecutionBinding | undefined,
): JsonRpcErrorObject {
  const leaseExpiresAt = binding?.leaseExpiresAt;
  return {
    code: RECOVERY_JSON_RPC_CODES.runtimeOwned,
    message,
    data: buildRecoveryErrorData("runtime_owned", {
      ownerInstanceId: binding?.ownerInstanceId,
      leaseExpiresAt,
      retryAfterMs: computeLeaseRetryAfterMs(leaseExpiresAt),
    }),
  };
}

export function buildSessionNotFoundError(sessionId: string): JsonRpcErrorObject {
  return {
    code: RECOVERY_JSON_RPC_CODES.sessionNotFound,
    message: `Persisted session not found: ${sessionId}`,
    data: buildRecoveryErrorData("session_not_found"),
  };
}

export function buildRecoveryFailedError(message: string): JsonRpcErrorObject {
  return {
    code: RECOVERY_JSON_RPC_CODES.recoveryFailed,
    message,
    data: buildRecoveryErrorData("recovery_failed"),
  };
}

/**
 * Structured failure of the all-or-nothing Team binding restoration (P1).
 *
 * - `missing_team_metadata` — durable metadata required to rebuild the
 *   bindings is absent (e.g. the Lead's `routaAgentId`). NOT retryable:
 *   retrying cannot restore missing durable state.
 * - `team_bindings_incomplete` — the restoration ran but could not rebuild
 *   every binding (store/orchestrator failure, unmappable descendants).
 *   Retryable: the cause is often transient.
 */
export interface TeamBindingFailure {
  code: "missing_team_metadata" | "team_bindings_incomplete";
  message: string;
  /** Durable fields that are absent (`missing_team_metadata` only). */
  missingMetadata?: string[];
  /** Binding categories that could not be restored. */
  missingBindings?: string[];
  /** Descendant sessions whose durable routa_agent_id is missing. */
  unmappedSessionIds?: string[];
}

/**
 * Structured recovery error for a ROUTA session whose Team runtime bindings
 * could not be fully restored. Recovery refuses to start a chat-only runtime:
 * the UI keeps history and input and shows an understandable, localized error.
 */
export function buildTeamBindingsFailedError(
  sessionId: string,
  failure: TeamBindingFailure | undefined,
): JsonRpcErrorObject {
  const isMissingMetadata = failure?.code === "missing_team_metadata";
  const detail = failure?.message ? `: ${failure.message}` : "";
  const message = isMissingMetadata
    ? `Team runtime recovery for ${sessionId} failed${detail} — missing team metadata ` +
      `(${(failure?.missingMetadata ?? []).join(", ") || "unknown"}). ` +
      "No runtime was started; the session keeps its history and input."
    : `Team runtime recovery for ${sessionId} failed to restore the team runtime bindings${detail}. ` +
      "No chat-only runtime was started; the session keeps its history and input.";
  return {
    code: RECOVERY_JSON_RPC_CODES.recoveryFailed,
    message,
    data: buildRecoveryErrorData("recovery_failed", {
      retryable: !isMissingMetadata,
      failure: failure?.code ?? "team_bindings_incomplete",
      ...(failure?.missingMetadata ? { missingMetadata: failure.missingMetadata } : {}),
      ...(failure?.missingBindings ? { missingBindings: failure.missingBindings } : {}),
      ...(failure?.unmappedSessionIds?.length
        ? { unmappedSessionIds: failure.unmappedSessionIds }
        : {}),
      sessionId,
    }),
  };
}

export function buildWorkspaceUnavailableError(message: string): JsonRpcErrorObject {
  return {
    code: RECOVERY_JSON_RPC_CODES.recoveryConfigurationUnavailable,
    message,
    data: buildRecoveryErrorData("workspace_unavailable"),
  };
}
