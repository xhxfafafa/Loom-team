import { describe, expect, it } from "vitest";

import {
  SESSION_STALE_THRESHOLD_MS,
  deriveSessionContinuityStatus,
} from "../session-continuity";

const NOW = new Date("2026-08-11T12:00:00.000Z").getTime();
const RECENT_CREATED_AT = "2026-08-11T09:00:00.000Z";

describe("deriveSessionContinuityStatus", () => {
  it("reports active when the local process manager has a live runtime", () => {
    expect(
      deriveSessionContinuityStatus(
        { hasActiveProcess: true, provider: "claude", createdAt: RECENT_CREATED_AT },
        NOW,
      ),
    ).toBe("active");
  });

  it("keeps live sessions active even when acpStatus is error", () => {
    // Characterization: liveness wins; error surfaces via acpStatus, not continuity.
    expect(
      deriveSessionContinuityStatus(
        { hasActiveProcess: true, acpStatus: "error", provider: "claude", createdAt: RECENT_CREATED_AT },
        NOW,
      ),
    ).toBe("active");
  });

  it("does not treat a persisted ready status as active without a live runtime", () => {
    // Regression: a stale in-memory/DB acpStatus=ready from a dead instance
    // previously rendered the session as active.
    expect(
      deriveSessionContinuityStatus(
        { hasActiveProcess: false, acpStatus: "ready", provider: "claude", createdAt: RECENT_CREATED_AT },
        NOW,
      ),
    ).toBe("restorable");
  });

  it("does not treat a persisted connecting status as active without a live runtime", () => {
    expect(
      deriveSessionContinuityStatus(
        { hasActiveProcess: false, acpStatus: "connecting", provider: "codex", createdAt: RECENT_CREATED_AT },
        NOW,
      ),
    ).toBe("restorable");
  });

  it("classifies dead sessions with resume-capable providers as restorable", () => {
    expect(
      deriveSessionContinuityStatus(
        { hasActiveProcess: false, provider: "codex", createdAt: RECENT_CREATED_AT },
        NOW,
      ),
    ).toBe("restorable");
    expect(
      deriveSessionContinuityStatus(
        { hasActiveProcess: false, provider: "opencode", createdAt: RECENT_CREATED_AT },
        NOW,
      ),
    ).toBe("restorable");
  });

  it("classifies dead sessions without resume capability as interrupted", () => {
    expect(
      deriveSessionContinuityStatus(
        { hasActiveProcess: false, provider: "gemini", createdAt: RECENT_CREATED_AT },
        NOW,
      ),
    ).toBe("interrupted");
    expect(
      deriveSessionContinuityStatus(
        { hasActiveProcess: false, provider: undefined, createdAt: RECENT_CREATED_AT },
        NOW,
      ),
    ).toBe("interrupted");
  });

  it("classifies old dead sessions as stale regardless of resume capability", () => {
    const old = new Date(NOW - SESSION_STALE_THRESHOLD_MS - 1000).toISOString();
    expect(
      deriveSessionContinuityStatus(
        { hasActiveProcess: false, provider: "claude", createdAt: old },
        NOW,
      ),
    ).toBe("stale");
  });

  it("trusts the last live acpStatus for runner-owned sessions", () => {
    expect(
      deriveSessionContinuityStatus(
        {
          hasActiveProcess: false,
          acpStatus: "ready",
          executionMode: "runner",
          provider: "opencode",
          createdAt: RECENT_CREATED_AT,
        },
        NOW,
      ),
    ).toBe("active");
  });

  it("does not trust error status for runner-owned sessions", () => {
    expect(
      deriveSessionContinuityStatus(
        {
          hasActiveProcess: false,
          acpStatus: "error",
          executionMode: "runner",
          provider: "opencode",
          createdAt: RECENT_CREATED_AT,
        },
        NOW,
      ),
    ).toBe("restorable");
  });

  it("falls back to the current time when createdAt is missing", () => {
    expect(
      deriveSessionContinuityStatus(
        { hasActiveProcess: false, provider: "claude", createdAt: null },
        NOW,
      ),
    ).toBe("restorable");
  });
});
