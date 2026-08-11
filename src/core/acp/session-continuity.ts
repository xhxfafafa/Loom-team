/**
 * Session continuity derivation.
 *
 * `continuityStatus` is derived on read from the actual runtime state; it is
 * never stored as a second source of truth. A persisted/in-memory
 * `acpStatus=ready` must not make a dead provider runtime appear active after
 * the owning process or instance has exited.
 *
 * See docs/design-docs/team-session-runtime-recovery.md ("Runtime states").
 */

import { getPresetById } from "@/core/acp/acp-presets";

export type SessionContinuityStatus = "active" | "interrupted" | "restorable" | "stale";

/** Sessions older than this without an active process are classified as stale (picker only; never deleted). */
export const SESSION_STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionContinuityInput {
  /** Whether the local process manager reports a live runtime for the session. */
  hasActiveProcess: boolean;
  /** Last known transient ACP status (in-memory; not durable). */
  acpStatus?: string | null;
  /** Execution binding mode from the durable record. */
  executionMode?: string | null;
  /** Provider registry id used to look up resume capabilities. */
  provider?: string | null;
  /** Session creation timestamp (ISO string or Date). */
  createdAt?: string | Date | null;
}

function toCreatedAtMs(createdAt: SessionContinuityInput["createdAt"], fallback: number): number {
  if (createdAt instanceof Date) {
    const value = createdAt.getTime();
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof createdAt === "string" && createdAt.length > 0) {
    const value = new Date(createdAt).getTime();
    return Number.isFinite(value) ? value : fallback;
  }
  return fallback;
}

/**
 * Derive the continuity status shown by session pickers and the Team UI.
 *
 * Rules (in order):
 * 1. A runtime that the local process manager reports as alive is `active`.
 * 2. Runner-mode sessions are owned by another process; the last live
 *    `acpStatus` is trusted because this instance cannot inspect them.
 * 3. Everything else is classified from durable facts only: age, then the
 *    provider's declared resume capability. A stale persisted
 *    `acpStatus=ready` never yields `active` on its own.
 */
export function deriveSessionContinuityStatus(
  input: SessionContinuityInput,
  now: number = Date.now(),
): SessionContinuityStatus {
  if (input.hasActiveProcess) {
    return "active";
  }

  if (
    input.executionMode === "runner"
    && (input.acpStatus === "ready" || input.acpStatus === "connecting")
  ) {
    return "active";
  }

  const createdAtMs = toCreatedAtMs(input.createdAt, now);
  const age = now - createdAtMs;
  if (age > SESSION_STALE_THRESHOLD_MS) {
    return "stale";
  }

  const preset = getPresetById(input.provider ?? "");
  if (preset?.resume?.supported) {
    return "restorable";
  }

  return "interrupted";
}
