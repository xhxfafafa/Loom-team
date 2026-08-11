import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Durable delivery state simulated as an append-once event set, mirroring
 * appendHistoryOnce/hasHistoryEvent semantics of the real stores. The append
 * mock returns the STRUCTURED outcome (never a bare boolean) so a DB failure
 * can be distinguished from a true duplicate or a missing session.
 */
const durableHistory = vi.hoisted(() => new Map<string, Set<string>>());
/** When set, the append mock fails with this error (DB unavailable). */
const appendFailure = vi.hoisted(() => ({ error: undefined as string | undefined }));

type AppendOutcome =
  | { status: "appended" }
  | { status: "duplicate" }
  | { status: "session_not_found" }
  | { status: "unavailable"; error: string };

const appendSessionNotificationEventOnceMock = vi.hoisted(() =>
  vi.fn(async (sessionId: string, notification: { eventId: string }): Promise<AppendOutcome> => {
    if (appendFailure.error) return { status: "unavailable", error: appendFailure.error };
    const events = durableHistory.get(sessionId);
    if (!events) return { status: "session_not_found" };
    if (events.has(notification.eventId)) return { status: "duplicate" };
    events.add(notification.eventId);
    return { status: "appended" };
  }),
);

const hasSessionHistoryEventInDbMock = vi.hoisted(() =>
  vi.fn(async (sessionId: string, eventId: string) => {
    return durableHistory.get(sessionId)?.has(eventId) ?? false;
  }),
);

vi.mock("@/core/acp/session-db-persister", () => ({
  appendSessionNotificationEventOnce: appendSessionNotificationEventOnceMock,
  hasSessionHistoryEventInDb: hasSessionHistoryEventInDbMock,
}));

const {
  acknowledgePromptDeliveryOnce,
  buildPromptDeliveryNotification,
  buildPromptDeliveryReceiptNotification,
  finalizePromptDelivery,
  resetInflightPromptDeliveriesForTest,
} = await import("../prompt-delivery");

describe("prompt-delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    durableHistory.clear();
    durableHistory.set("session-1", new Set());
    appendFailure.error = undefined;
    resetInflightPromptDeliveriesForTest();
  });

  it("builds a user-message delivery notification keyed by promptId", () => {
    const notification = buildPromptDeliveryNotification("session-1", "prompt-1", "hello");
    expect(notification).toEqual({
      sessionId: "session-1",
      eventId: "prompt-1",
      update: {
        sessionUpdate: "user_message",
        content: { type: "text", text: "hello" },
      },
    });
  });

  it("builds a delivery receipt whose eventId is the deliveryId + :delivered", () => {
    const receipt = buildPromptDeliveryReceiptNotification(
      "session-1",
      "team-report:p:c:t:0",
    );
    expect(receipt.eventId).toBe("team-report:p:c:t:0:delivered");
    expect(receipt.update).toMatchObject({
      sessionUpdate: "delivery_receipt",
      deliveryId: "team-report:p:c:t:0",
    });
  });

  it("records a new promptId exactly once", async () => {
    const ack = await acknowledgePromptDeliveryOnce("session-1", "prompt-1", "hello");
    expect(ack).toEqual({ status: "accepted", duplicate: false, recorded: true });
    expect(durableHistory.get("session-1")?.has("prompt-1")).toBe(true);
  });

  it("reports an in-flight concurrent duplicate without touching durable state", async () => {
    await acknowledgePromptDeliveryOnce("session-1", "prompt-1", "hello");

    const second = await acknowledgePromptDeliveryOnce("session-1", "prompt-1", "hello");

    expect(second).toEqual({ status: "duplicate", duplicate: true, recorded: false });
    // Only the first ack appended.
    expect(appendSessionNotificationEventOnceMock).toHaveBeenCalledTimes(1);
  });

  it("treats a recorded non-team promptId as duplicate after finalization", async () => {
    await acknowledgePromptDeliveryOnce("session-1", "prompt-1", "hello");
    finalizePromptDelivery("prompt-1");

    const retry = await acknowledgePromptDeliveryOnce("session-1", "prompt-1", "hello");

    expect(retry).toEqual({ status: "duplicate", duplicate: true, recorded: false });
    expect(appendSessionNotificationEventOnceMock).toHaveBeenCalledTimes(1);
  });

  it("re-delivers a recorded team report without a receipt (at-least-once)", async () => {
    const deliveryId = "team-report:lead:child:task-1:0";
    durableHistory.get("session-1")!.add(deliveryId);

    const ack = await acknowledgePromptDeliveryOnce("session-1", deliveryId, "report");

    expect(ack).toEqual({ status: "accepted", duplicate: false, recorded: true });
    // Already recorded: must NOT append again.
    expect(appendSessionNotificationEventOnceMock).not.toHaveBeenCalled();
  });

  it("treats a team report with a delivered receipt as duplicate", async () => {
    const deliveryId = "team-report:lead:child:task-1:0";
    durableHistory.get("session-1")!.add(deliveryId);
    durableHistory.get("session-1")!.add(`${deliveryId}:delivered`);

    const ack = await acknowledgePromptDeliveryOnce("session-1", deliveryId, "report");

    expect(ack).toEqual({ status: "duplicate", duplicate: true, recorded: false });
  });

  it("reports duplicate when the append race is lost to a concurrent writer", async () => {
    appendSessionNotificationEventOnceMock.mockResolvedValueOnce({ status: "duplicate" });

    const ack = await acknowledgePromptDeliveryOnce("session-1", "prompt-race", "hello");

    expect(ack).toEqual({ status: "duplicate", duplicate: true, recorded: false });
  });

  it("reports session_not_found for unknown sessions instead of a duplicate ack", async () => {
    const ack = await acknowledgePromptDeliveryOnce("missing-session", "prompt-x", "hello");
    // A missing session is NOT an already-delivered prompt: the caller must
    // fail the delivery, not answer promptAccepted/duplicate.
    expect(ack).toEqual({ status: "session_not_found", duplicate: false, recorded: false });
  });

  it("fails closed when durable persistence is unavailable (never reports duplicate)", async () => {
    appendFailure.error = "database is locked";

    const ack = await acknowledgePromptDeliveryOnce("session-1", "prompt-unavailable", "hello");

    // The write could not be proven: the caller must surface a structured,
    // retryable failure instead of claiming the prompt was already delivered.
    expect(ack).toEqual({
      status: "unavailable",
      duplicate: false,
      recorded: false,
      error: "database is locked",
    });
    // No in-flight marker: a retry after recovery may attempt the append.
    const retry = await acknowledgePromptDeliveryOnce("session-1", "prompt-unavailable", "hello");
    expect(retry.status).toBe("unavailable");
    expect(appendSessionNotificationEventOnceMock).toHaveBeenCalledTimes(2);
  });
});
