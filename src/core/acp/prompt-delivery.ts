/**
 * Prompt delivery acknowledgement.
 *
 * Every prompt that carries a `promptId` (a client-generated UUID for user
 * prompts, the deterministic `team-report:…` delivery ID for child reports,
 * `resume:…` for explicit Resume) is durably acknowledged exactly once before
 * it is dispatched to a provider runtime:
 *
 *   1. the user message / delivery event is recorded with
 *      `appendHistoryOnce` keyed by the promptId;
 *   2. a duplicate promptId never appends or dispatches twice during normal
 *      retries;
 *   3. Team report deliveries are at-least-once: a recorded report WITHOUT a
 *      durable `:delivered` receipt crashed before provider acceptance and is
 *      re-dispatched (without re-appending). Routa does not claim
 *      exactly-once provider execution across a crash after provider
 *      acceptance but before the receipt was persisted.
 *
 * The promptId is an idempotency key for the triggering delivery only. It is
 * never a provider conversation ID and never feeds back into `routa_agent_id`
 * or `provider_session_id`.
 */

import {
  appendSessionNotificationEventOnce,
  hasSessionHistoryEventInDb,
} from "@/core/acp/session-db-persister";
import {
  buildTeamReportDeliveryReceiptId,
  isTeamReportDeliveryId,
} from "@/core/orchestration/team-report-delivery";

/**
 * A concurrent duplicate (double-clicked prompt, racing child-report retry)
 * is only possible within one instance and within a short window. Entries
 * older than this TTL are treated as crashed in-flight attempts and fall
 * through to the durable state instead of blocking forever.
 */
const INFLIGHT_PROMPT_DELIVERY_TTL_MS = 120_000;

const inflightPromptDeliveries = new Map<string, number>();

export type PromptDeliveryAck =
  /** The delivery was newly accepted (or re-accepted for redelivery). */
  | { status: "accepted"; duplicate: false; recorded: true }
  /** A TRUE duplicate: this promptId was already acknowledged/dispatched —
   * callers must re-emit the existing acknowledgement instead of appending
   * or dispatching again. Never reported for persistence failures. */
  | { status: "duplicate"; duplicate: true; recorded: false }
  /** The durable session row does not exist; the delivery cannot be recorded. */
  | { status: "session_not_found"; duplicate: false; recorded: false }
  /** The durable append could not be proven (DB unavailable). Callers must
   * fail the prompt (no dispatch, no promptAccepted) and keep the user input
   * for a retry — never treat this as a duplicate. */
  | { status: "unavailable"; duplicate: false; recorded: false; error: string };

/** Build the durable user-message/delivery event for a promptId. */
export function buildPromptDeliveryNotification(
  sessionId: string,
  promptId: string,
  promptText: string,
): { sessionId: string; eventId: string; update: Record<string, unknown> } {
  return {
    sessionId,
    eventId: promptId,
    update: {
      sessionUpdate: "user_message",
      content: { type: "text", text: promptText },
    },
  };
}

/**
 * Build the durable delivery receipt for a (Team report) promptId. Written
 * only after the provider accepted the report prompt; its presence is what
 * turns a recorded delivery into a completed one.
 */
export function buildPromptDeliveryReceiptNotification(
  sessionId: string,
  promptId: string,
): { sessionId: string; eventId: string; update: Record<string, unknown> } {
  return {
    sessionId,
    eventId: buildTeamReportDeliveryReceiptId(promptId),
    update: {
      sessionUpdate: "delivery_receipt",
      deliveryId: promptId,
    },
  };
}

/**
 * Acknowledge a prompt delivery durably. Must be called AFTER the session
 * runtime was ensured (recovery) and BEFORE the prompt is dispatched.
 */
export async function acknowledgePromptDeliveryOnce(
  sessionId: string,
  promptId: string,
  promptText: string,
): Promise<PromptDeliveryAck> {
  const now = Date.now();

  // Single-flight within this instance. Stale entries are crashed in-flight
  // attempts and fall through to the durable state below.
  const startedAt = inflightPromptDeliveries.get(promptId);
  if (startedAt !== undefined) {
    if (now - startedAt < INFLIGHT_PROMPT_DELIVERY_TTL_MS) {
      return { status: "duplicate", duplicate: true, recorded: false };
    }
    inflightPromptDeliveries.delete(promptId);
  }

  const alreadyRecorded = await hasSessionHistoryEventInDb(sessionId, promptId);
  if (alreadyRecorded) {
    const redeliveryAllowed = isTeamReportDeliveryId(promptId)
      && !(await hasSessionHistoryEventInDb(sessionId, buildTeamReportDeliveryReceiptId(promptId)));
    if (!redeliveryAllowed) {
      return { status: "duplicate", duplicate: true, recorded: false };
    }
  } else {
    const appendOutcome = await appendSessionNotificationEventOnce(
      sessionId,
      buildPromptDeliveryNotification(sessionId, promptId, promptText),
    );
    if (appendOutcome.status === "duplicate") {
      // Lost the append race to a concurrent writer. The winner delivers the
      // prompt; this caller reports a duplicate instead of double-dispatching.
      return { status: "duplicate", duplicate: true, recorded: false };
    }
    if (appendOutcome.status === "session_not_found") {
      // No durable session row: nothing was recorded and nothing may be
      // dispatched. This is NOT an already-delivered prompt.
      return { status: "session_not_found", duplicate: false, recorded: false };
    }
    if (appendOutcome.status === "unavailable") {
      // The write could not be proven. Fail closed: the caller must not
      // dispatch the prompt, must not answer promptAccepted, and must keep
      // the user input so the delivery can be retried. No in-flight marker —
      // the retry may attempt the append again once storage recovers.
      return { status: "unavailable", duplicate: false, recorded: false, error: appendOutcome.error };
    }
  }

  inflightPromptDeliveries.set(promptId, now);
  return { status: "accepted", duplicate: false, recorded: true };
}

/** Clear the in-flight marker once a delivery finished (success or error). */
export function finalizePromptDelivery(promptId: string | undefined): void {
  if (!promptId) return;
  inflightPromptDeliveries.delete(promptId);
}

/** Test hook: drop all in-flight delivery markers. */
export function resetInflightPromptDeliveriesForTest(): void {
  inflightPromptDeliveries.clear();
}
