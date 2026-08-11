import { describe, expect, it } from "vitest";

import {
  extractDelegationSessionId,
  resolveDelegationRosterSpecialistId,
  resolveDelegationTarget,
  resolveRosterSpecialistId,
  resolveSessionRuntimeStatus,
  resolveTeamPromptErrorI18nKey,
} from "../team-run-page-model";

describe("team-run-page-model", () => {
  it("extracts delegated child session id from tool output", () => {
    expect(extractDelegationSessionId({
      rawOutput: {
        output: "{\"success\":true,\"sessionId\":\"child-123\",\"agentId\":\"agent-1\"}",
      },
    })).toBe("child-123");
  });

  it("falls back to delegated roster mapping for child sessions without specialist ids", () => {
    const delegatedRosterIdsBySessionId = new Map([
      ["child-123", "team-backend-dev"],
    ]);

    expect(resolveRosterSpecialistId({
      sessionId: "child-123",
      cwd: "/tmp",
      workspaceId: "default",
      createdAt: "2026-03-23T00:00:00.000Z",
      role: "CRAFTER",
    }, undefined, delegatedRosterIdsBySessionId)).toBe("team-backend-dev");
  });

  it("maps specialist aliases from delegation tool calls to team roster roles", () => {
    expect(resolveDelegationRosterSpecialistId({
      rawInput: {
        specialist: "researcher",
      },
    })).toBe("team-researcher");

    expect(resolveDelegationRosterSpecialistId({
      rawInput: {
        specialist: "backend-dev",
      },
    })).toBe("team-backend-dev");

    expect(resolveDelegationRosterSpecialistId({
      rawInput: {
        specialist: "qa",
      },
    })).toBe("team-qa");
  });

  it("renders human labels for delegation aliases", () => {
    expect(resolveDelegationTarget({
      rawInput: {
        specialist: "researcher",
      },
    })).toBe("Research Analyst");

    expect(resolveDelegationTarget({
      rawInput: {
        specialist: "backend-dev",
      },
    })).toBe("Backend Developer");
  });

  describe("resolveSessionRuntimeStatus", () => {
    it("reports working only when the runtime continuity is active", () => {
      expect(resolveSessionRuntimeStatus({
        acpStatus: "ready",
        continuityStatus: "active",
      })).toBe("working");
    });

    it("does not report a persisted ready status as working without an active runtime", () => {
      // Regression: the Team Lead used to be hard-coded as "working" whenever
      // it was not in an error state, even after the provider process exited.
      expect(resolveSessionRuntimeStatus({
        acpStatus: "ready",
        continuityStatus: "restorable",
      })).toBe("suspended");
      expect(resolveSessionRuntimeStatus({
        acpStatus: undefined,
        continuityStatus: "restorable",
      })).toBe("suspended");
    });

    it("labels recovery-in-progress and failed runtimes distinctly", () => {
      expect(resolveSessionRuntimeStatus({
        acpStatus: "connecting",
        continuityStatus: "restorable",
      })).toBe("recovering");
      expect(resolveSessionRuntimeStatus({
        acpStatus: "error",
        continuityStatus: "interrupted",
      })).toBe("failed");
    });

    it("treats interrupted and stale sessions without an error as suspended", () => {
      expect(resolveSessionRuntimeStatus({
        acpStatus: undefined,
        continuityStatus: "interrupted",
      })).toBe("suspended");
      expect(resolveSessionRuntimeStatus({
        acpStatus: undefined,
        continuityStatus: "stale",
      })).toBe("suspended");
    });
  });

  // ── P1-2: structured recovery errors map to understandable i18n keys ────
  // The Team composer must show a localized, actionable message for recovery
  // failures (never a silently degraded chat), keyed off the structured
  // JSON-RPC `data.reason`/`data.failure` — not the raw English message.
  describe("resolveTeamPromptErrorI18nKey", () => {
    it("maps each structured recovery failure to a team i18n key", () => {
      expect(resolveTeamPromptErrorI18nKey({
        code: -32010,
        data: { reason: "runtime_owned", retryable: true },
      })).toBe("promptErrorRuntimeOwned");

      expect(resolveTeamPromptErrorI18nKey({
        code: -32011,
        data: { reason: "recovery_unavailable", retryable: true },
      })).toBe("promptErrorRecoveryUnavailable");

      expect(resolveTeamPromptErrorI18nKey({
        code: -32004,
        data: { reason: "session_not_found", retryable: false },
      })).toBe("promptErrorSessionNotFound");

      expect(resolveTeamPromptErrorI18nKey({
        code: -32012,
        data: { reason: "recovery_failed", failure: "missing_team_metadata", retryable: false },
      })).toBe("promptErrorMissingTeamMetadata");

      expect(resolveTeamPromptErrorI18nKey({
        code: -32012,
        data: { reason: "recovery_failed", failure: "team_bindings_incomplete", retryable: true },
      })).toBe("promptErrorTeamBindingsIncomplete");
    });

    it("returns null for errors without a structured recovery reason", () => {
      expect(resolveTeamPromptErrorI18nKey(new Error("boom"))).toBeNull();
      expect(resolveTeamPromptErrorI18nKey(undefined)).toBeNull();
      expect(resolveTeamPromptErrorI18nKey({ code: -32000, message: "generic" })).toBeNull();
      // recovery_failed without a `failure` discriminator is a generic
      // recovery error; it falls back to the raw message, not a team key.
      expect(resolveTeamPromptErrorI18nKey({
        code: -32012,
        data: { reason: "recovery_failed" },
      })).toBeNull();
    });
  });
});
