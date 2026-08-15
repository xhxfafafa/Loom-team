import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPendingPrompt,
  consumePendingPromptPayload,
  ensurePendingPromptDeliveryId,
  peekPendingPromptPayload,
  storePendingPrompt,
} from "../utils/pending-prompt";

describe("pending-prompt payload handoff", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("stores and peeks a structured payload without deleting it", () => {
    const stored = storePendingPrompt("session-1", {
      text: "Deliver feature X",
      attachmentTransferId: "transfer-1",
      repositoryFiles: [{ path: "src/a.ts", label: "a.ts" }],
    });
    expect(stored).toBe(true);

    const first = peekPendingPromptPayload("session-1");
    expect(first).toMatchObject({
      text: "Deliver feature X",
      attachmentTransferId: "transfer-1",
      repositoryFiles: [{ path: "src/a.ts", label: "a.ts" }],
    });
    // Non-destructive: the payload must survive repeated peeks so a failed
    // first prompt can retry with the same transfer metadata.
    expect(peekPendingPromptPayload("session-1")).toMatchObject({ text: "Deliver feature X" });
  });

  it("keeps only transfer metadata in sessionStorage, never file content", () => {
    storePendingPrompt("session-2", {
      text: "request",
      attachmentTransferId: "transfer-9",
    });
    const raw = sessionStorage.getItem("routa_pending_prompt_session-2") ?? "";
    const payload = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ["attachmentTransferId", "promptId", "text", "timestamp"].sort(),
    );
    expect(raw).not.toContain("base64");
  });

  it("assigns one stable promptId at storage and keeps it across peeks", () => {
    storePendingPrompt("session-prompt-id", {
      text: "Coordinate this team run",
      attachmentTransferId: "transfer-1",
    });
    const first = peekPendingPromptPayload("session-prompt-id");
    expect(first?.promptId).toEqual(expect.any(String));
    expect(first?.promptId?.length).toBeGreaterThan(0);
    // Recovery retries must reuse ONE delivery identity: repeated peeks and a
    // consume must all observe the same promptId that was assigned at storage.
    expect(peekPendingPromptPayload("session-prompt-id")?.promptId).toBe(first?.promptId);
    expect(consumePendingPromptPayload("session-prompt-id")?.promptId).toBe(first?.promptId);
  });

  it("keeps a payload readable beyond 30 seconds when the reader allows a Team window", () => {
    // Regression: a pending Team launch prompt must survive a legitimate
    // lease wait (default lease: five minutes), not expire with the 30s
    // default handoff window.
    sessionStorage.setItem(
      "routa_pending_prompt_session-team-window",
      JSON.stringify({
        text: "launch the team",
        timestamp: Date.now() - 40_000,
        promptId: "stable-prompt-1",
      }),
    );
    // Default surfaces keep the 30-second window.
    expect(peekPendingPromptPayload("session-team-window")).toBeNull();
    // The Team page reads with a ten-minute window.
    const payload = peekPendingPromptPayload("session-team-window", { maxAgeMs: 600_000 });
    expect(payload).toMatchObject({ text: "launch the team", promptId: "stable-prompt-1" });
    // Beyond the Team window the payload still expires.
    expect(
      peekPendingPromptPayload("session-team-window", { maxAgeMs: 10_000 }),
    ).toBeNull();
  });

  it("ensures a delivery id for legacy entries without touching the timestamp", () => {
    const timestamp = Date.now() - 5_000;
    sessionStorage.setItem(
      "routa_pending_prompt_session-legacy",
      JSON.stringify({ text: "legacy launch", timestamp }),
    );
    const assigned = ensurePendingPromptDeliveryId("session-legacy");
    expect(assigned).toEqual(expect.any(String));
    const stored = JSON.parse(
      sessionStorage.getItem("routa_pending_prompt_session-legacy") ?? "{}",
    ) as Record<string, unknown>;
    expect(stored.promptId).toBe(assigned);
    // The retention window still runs from the ORIGINAL storage time.
    expect(stored.timestamp).toBe(timestamp);
    // A second call reuses the same identity.
    expect(ensurePendingPromptDeliveryId("session-legacy")).toBe(assigned);
    expect(ensurePendingPromptDeliveryId("session-missing")).toBeNull();
  });

  it("clears the payload on demand", () => {
    storePendingPrompt("session-3", "plain text");
    expect(peekPendingPromptPayload("session-3")).not.toBeNull();
    clearPendingPrompt("session-3");
    expect(peekPendingPromptPayload("session-3")).toBeNull();
  });

  it("consume reads once and then removes the payload", () => {
    storePendingPrompt("session-4", { text: "once", skillName: "skill", skillRepoPath: "/repo" });
    const consumed = consumePendingPromptPayload("session-4");
    expect(consumed).toMatchObject({ text: "once", skillName: "skill", skillRepoPath: "/repo" });
    expect(consumePendingPromptPayload("session-4")).toBeNull();
    expect(peekPendingPromptPayload("session-4")).toBeNull();
  });

  it("accepts plain string input as a text-only payload", () => {
    storePendingPrompt("session-5", "just text");
    const payload = peekPendingPromptPayload("session-5");
    expect(payload?.text).toBe("just text");
    expect(payload?.attachmentTransferId).toBeUndefined();
    expect(payload?.repositoryFiles).toBeUndefined();
  });

  it("discards payloads older than 30 seconds", () => {
    sessionStorage.setItem(
      "routa_pending_prompt_session-6",
      JSON.stringify({ text: "stale", timestamp: Date.now() - 31_000 }),
    );
    expect(peekPendingPromptPayload("session-6")).toBeNull();
  });
});
