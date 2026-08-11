/**
 * Team report delivery identity.
 *
 * Child completion reports wake the Lead through the same recover-aware
 * prompt entry point as user prompts. To keep that delivery idempotent across
 * restarts and retries, every report carries a DETERMINISTIC delivery ID
 * derived from durable identities only:
 *
 *   team-report:<parent-session-id>:<child-session-id>:<task-id>:<report-revision>
 *
 * The delivery ID is an idempotency key for the triggering delivery — it is
 * never a provider conversation ID and it never feeds back into
 * `routa_agent_id` or any provider session ID.
 *
 * Delivery receipts append `:delivered` to the delivery ID. The receipt is
 * written only after the provider accepted the report prompt; it is what
 * separates "recorded but not yet delivered" (at-least-once re-dispatch is
 * allowed) from "delivered" (a duplicate must not append or dispatch again).
 */

export const TEAM_REPORT_DELIVERY_PREFIX = "team-report:";
export const TEAM_REPORT_DELIVERY_RECEIPT_SUFFIX = ":delivered";

export interface TeamReportDeliveryIdentity {
  /** Durable Routa Session ID of the Lead (parent) session. */
  parentSessionId: string;
  /** Durable Routa Session ID of the child session that produced the report. */
  childSessionId: string;
  /** Durable task ID the report belongs to. */
  taskId: string;
  /**
   * Which revision of the report this is for the same child + task pair.
   * Revision 0 is the first report; a re-report after a fix gets the count of
   * previously DELIVERED receipts, which is durable and stable across retries.
   */
  reportRevision: number | string;
}

export interface ParsedTeamReportDeliveryId extends TeamReportDeliveryIdentity {
  reportRevision: string;
}

/** Build the deterministic delivery ID for a child completion report. */
export function buildTeamReportDeliveryId(
  identity: TeamReportDeliveryIdentity,
): string {
  return (
    `${TEAM_REPORT_DELIVERY_PREFIX}${identity.parentSessionId}` +
    `:${identity.childSessionId}:${identity.taskId}:${identity.reportRevision}`
  );
}

/** Build the durable delivery-receipt event ID for a delivery ID. */
export function buildTeamReportDeliveryReceiptId(deliveryId: string): string {
  return `${deliveryId}${TEAM_REPORT_DELIVERY_RECEIPT_SUFFIX}`;
}

/** True when the value is shaped like a Team report delivery ID. */
export function isTeamReportDeliveryId(value: string | undefined): value is string {
  return typeof value === "string"
    && value.startsWith(TEAM_REPORT_DELIVERY_PREFIX)
    && !value.endsWith(TEAM_REPORT_DELIVERY_RECEIPT_SUFFIX)
    && parseTeamReportDeliveryId(value) !== undefined;
}

/** True when the value is a Team report delivery receipt event ID. */
export function isTeamReportDeliveryReceiptId(value: string | undefined): value is string {
  return typeof value === "string"
    && value.endsWith(TEAM_REPORT_DELIVERY_RECEIPT_SUFFIX)
    && isTeamReportDeliveryId(value.slice(0, -TEAM_REPORT_DELIVERY_RECEIPT_SUFFIX.length));
}

/**
 * Parse a delivery ID back into its durable identity parts. Returns undefined
 * for anything that is not a well-formed Team report delivery ID.
 */
export function parseTeamReportDeliveryId(
  deliveryId: string,
): ParsedTeamReportDeliveryId | undefined {
  if (!deliveryId.startsWith(TEAM_REPORT_DELIVERY_PREFIX)) return undefined;

  const parts = deliveryId.slice(TEAM_REPORT_DELIVERY_PREFIX.length).split(":");
  if (parts.length !== 4) return undefined;

  const [parentSessionId, childSessionId, taskId, reportRevision] = parts;
  if (!parentSessionId || !childSessionId || !taskId || !reportRevision) {
    return undefined;
  }

  return { parentSessionId, childSessionId, taskId, reportRevision };
}

/**
 * Count previously DELIVERED Team report receipts for one child + task pair.
 * Used to derive the next deterministic `reportRevision`: retries of the same
 * delivery never see a new receipt, so the revision stays stable while a
 * delivery is in flight or crashed mid-flight.
 */
export function countDeliveredTeamReports(
  history: Array<{ eventId?: string | null }>,
  match: { parentSessionId: string; childSessionId: string; taskId: string },
): number {
  let count = 0;
  for (const entry of history) {
    const eventId = entry.eventId;
    if (typeof eventId !== "string") continue;
    if (!eventId.endsWith(TEAM_REPORT_DELIVERY_RECEIPT_SUFFIX)) continue;

    const parsed = parseTeamReportDeliveryId(
      eventId.slice(0, -TEAM_REPORT_DELIVERY_RECEIPT_SUFFIX.length),
    );
    if (!parsed) continue;
    if (
      parsed.parentSessionId === match.parentSessionId
      && parsed.childSessionId === match.childSessionId
      && parsed.taskId === match.taskId
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * True when the durable history of the parent session contains at least one
 * DELIVERED Team report receipt for the given child session. This is the
 * completed-child release precondition: a child runtime may only be
 * auto-released after its completion report is durably accepted by the
 * parent, so the report survives the release.
 */
export function hasDeliveredTeamReportForChild(
  history: Array<{ eventId?: string | null }>,
  match: { parentSessionId: string; childSessionId: string },
): boolean {
  for (const entry of history) {
    const eventId = entry.eventId;
    if (typeof eventId !== "string") continue;
    if (!eventId.endsWith(TEAM_REPORT_DELIVERY_RECEIPT_SUFFIX)) continue;

    const parsed = parseTeamReportDeliveryId(
      eventId.slice(0, -TEAM_REPORT_DELIVERY_RECEIPT_SUFFIX.length),
    );
    if (!parsed) continue;
    if (
      parsed.parentSessionId === match.parentSessionId
      && parsed.childSessionId === match.childSessionId
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Derive the deterministic delivery ID for the next completion report of a
 * (parent, child, task) triple from durable history: the revision is the
 * number of previously DELIVERED receipts for that triple. This is stable
 * across retries because no receipt exists while a delivery is in flight.
 * A history read failure degrades to revision 0 (the delivery stays
 * at-least-once; the append-side idempotency check still guards duplicates).
 */
export async function deriveNextTeamReportDeliveryId(identity: {
  parentSessionId: string;
  childSessionId: string;
  taskId: string;
}): Promise<string> {
  let reportRevision = 0;
  try {
    const { loadHistorySinceEventIdFromDb } = await import("@/core/acp/session-db-persister");
    const history = await loadHistorySinceEventIdFromDb(identity.parentSessionId, "");
    reportRevision = countDeliveredTeamReports(history, identity);
  } catch (err) {
    console.warn(
      `[TeamReportDelivery] Could not count delivered team reports for ${identity.parentSessionId}; assuming revision 0`,
      err,
    );
  }
  return buildTeamReportDeliveryId({ ...identity, reportRevision });
}
