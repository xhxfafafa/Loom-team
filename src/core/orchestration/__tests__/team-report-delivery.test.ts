import { describe, expect, it, vi } from "vitest";

const loadHistorySinceEventIdFromDbMock = vi.hoisted(() =>
  vi.fn(async (_sessionId: string, _afterEventId: string) => [] as Array<{ eventId?: string | null }>),
);

vi.mock("@/core/acp/session-db-persister", () => ({
  loadHistorySinceEventIdFromDb: loadHistorySinceEventIdFromDbMock,
}));

import {
  buildTeamReportDeliveryId,
  buildTeamReportDeliveryReceiptId,
  countDeliveredTeamReports,
  deriveNextTeamReportDeliveryId,
  hasDeliveredTeamReportForChild,
  isTeamReportDeliveryId,
  isTeamReportDeliveryReceiptId,
  parseTeamReportDeliveryId,
} from "../team-report-delivery";

const IDENTITY = {
  parentSessionId: "parent-session",
  childSessionId: "child-session",
  taskId: "task-1",
  reportRevision: 0,
};

describe("team report delivery identity", () => {
  it("builds the deterministic delivery ID format from durable identities only", () => {
    expect(buildTeamReportDeliveryId(IDENTITY)).toBe(
      "team-report:parent-session:child-session:task-1:0",
    );
  });

  it("is deterministic across retries for the same durable inputs", () => {
    expect(buildTeamReportDeliveryId({ ...IDENTITY, reportRevision: "0" })).toBe(
      buildTeamReportDeliveryId(IDENTITY),
    );
  });

  it("parses delivery IDs back into their identity parts", () => {
    const deliveryId = buildTeamReportDeliveryId({ ...IDENTITY, reportRevision: 3 });
    expect(parseTeamReportDeliveryId(deliveryId)).toEqual({
      parentSessionId: "parent-session",
      childSessionId: "child-session",
      taskId: "task-1",
      reportRevision: "3",
    });
  });

  it("rejects malformed or foreign delivery IDs", () => {
    expect(parseTeamReportDeliveryId("user-prompt:abc")).toBeUndefined();
    expect(parseTeamReportDeliveryId("team-report:only-three:parts")).toBeUndefined();
    expect(parseTeamReportDeliveryId("team-report:a:b:c:d:extra")).toBeUndefined();
    expect(parseTeamReportDeliveryId("")).toBeUndefined();
    expect(isTeamReportDeliveryId("team-report:a:b:c:0:delivered")).toBe(false);
    expect(isTeamReportDeliveryId(undefined)).toBe(false);
    expect(isTeamReportDeliveryId("some-random-event")).toBe(false);
  });

  it("recognizes delivery IDs and receipt IDs", () => {
    const deliveryId = buildTeamReportDeliveryId(IDENTITY);
    const receiptId = buildTeamReportDeliveryReceiptId(deliveryId);

    expect(isTeamReportDeliveryId(deliveryId)).toBe(true);
    expect(isTeamReportDeliveryReceiptId(receiptId)).toBe(true);
    expect(isTeamReportDeliveryId(receiptId)).toBe(false);
    expect(isTeamReportDeliveryReceiptId(deliveryId)).toBe(false);
    expect(receiptId).toBe("team-report:parent-session:child-session:task-1:0:delivered");
  });

  it("counts only delivered receipts for the matching child + task pair", () => {
    const delivered = buildTeamReportDeliveryReceiptId(buildTeamReportDeliveryId(IDENTITY));
    const deliveredAgain = buildTeamReportDeliveryReceiptId(
      buildTeamReportDeliveryId({ ...IDENTITY, reportRevision: 1 }),
    );
    const otherTask = buildTeamReportDeliveryReceiptId(
      buildTeamReportDeliveryId({ ...IDENTITY, taskId: "task-2" }),
    );
    const otherChild = buildTeamReportDeliveryReceiptId(
      buildTeamReportDeliveryId({ ...IDENTITY, childSessionId: "child-2" }),
    );
    const pendingOnly = buildTeamReportDeliveryId({ ...IDENTITY, reportRevision: 2 });

    const history = [
      { eventId: delivered },
      { eventId: "unrelated-event" },
      { eventId: deliveredAgain },
      { eventId: otherTask },
      { eventId: otherChild },
      { eventId: pendingOnly }, // recorded but not delivered → not counted
      {},
    ];

    expect(
      countDeliveredTeamReports(history, {
        parentSessionId: "parent-session",
        childSessionId: "child-session",
        taskId: "task-1",
      }),
    ).toBe(2);
  });

  it("detects a durable delivered receipt for one child in the parent history", () => {
    const delivered = buildTeamReportDeliveryReceiptId(buildTeamReportDeliveryId(IDENTITY));
    const deliveredOtherTask = buildTeamReportDeliveryReceiptId(
      buildTeamReportDeliveryId({ ...IDENTITY, taskId: "task-2", reportRevision: 1 }),
    );
    const pendingOnly = buildTeamReportDeliveryId({ ...IDENTITY, reportRevision: 2 });
    const otherChild = buildTeamReportDeliveryReceiptId(
      buildTeamReportDeliveryId({ ...IDENTITY, childSessionId: "child-2" }),
    );
    const otherParent = buildTeamReportDeliveryReceiptId(
      buildTeamReportDeliveryId({ ...IDENTITY, parentSessionId: "other-parent" }),
    );

    const match = { parentSessionId: "parent-session", childSessionId: "child-session" };

    // Any delivered receipt for the child (any task/revision) satisfies the
    // completed-release precondition.
    expect(hasDeliveredTeamReportForChild([{ eventId: delivered }], match)).toBe(true);
    expect(hasDeliveredTeamReportForChild([{ eventId: deliveredOtherTask }], match)).toBe(true);

    // Recorded-but-not-delivered events, other children, and other parents do not.
    expect(hasDeliveredTeamReportForChild([{ eventId: pendingOnly }], match)).toBe(false);
    expect(hasDeliveredTeamReportForChild([{ eventId: otherChild }], match)).toBe(false);
    expect(hasDeliveredTeamReportForChild([{ eventId: otherParent }], match)).toBe(false);
    expect(hasDeliveredTeamReportForChild([{}, { eventId: null }], match)).toBe(false);
    expect(hasDeliveredTeamReportForChild([], match)).toBe(false);
  });
});

describe("deriveNextTeamReportDeliveryId", () => {
  const TRIPLE = {
    parentSessionId: "parent-session",
    childSessionId: "child-session",
    taskId: "task-1",
  };

  it("uses the count of previously DELIVERED receipts as the revision", async () => {
    loadHistorySinceEventIdFromDbMock.mockResolvedValueOnce([
      { eventId: "team-report:parent-session:child-session:task-1:0:delivered" },
      { eventId: "team-report:parent-session:child-session:task-1:1:delivered" },
      { eventId: "team-report:parent-session:child-session:task-1:2" }, // pending → ignored
      { eventId: "team-report:parent-session:child-session:task-2:0:delivered" }, // other task
    ]);

    const deliveryId = await deriveNextTeamReportDeliveryId(TRIPLE);

    expect(loadHistorySinceEventIdFromDbMock).toHaveBeenCalledWith("parent-session", "");
    expect(deliveryId).toBe("team-report:parent-session:child-session:task-1:2");
  });

  it("falls back to revision 0 when the durable history cannot be read", async () => {
    loadHistorySinceEventIdFromDbMock.mockRejectedValueOnce(new Error("db offline"));

    const deliveryId = await deriveNextTeamReportDeliveryId(TRIPLE);

    expect(deliveryId).toBe("team-report:parent-session:child-session:task-1:0");
  });
});
