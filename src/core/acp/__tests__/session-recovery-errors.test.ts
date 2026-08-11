import { describe, expect, it } from "vitest";

import {
  buildRecoveryErrorData,
  buildRuntimeOwnedError,
  buildSessionNotFoundError,
  buildTeamBindingsFailedError,
  computeLeaseRetryAfterMs,
  isRetryableRecoveryReason,
  RECOVERY_JSON_RPC_CODES,
} from "../session-recovery-errors";

describe("session-recovery-errors", () => {
  it("uses the stable JSON-RPC codes from the recovery contract", () => {
    expect(RECOVERY_JSON_RPC_CODES).toEqual({
      invalidParams: -32602,
      sessionNotFound: -32004,
      runtimeOwned: -32010,
      recoveryUnavailable: -32011,
      recoveryFailed: -32012,
      recoveryConfigurationUnavailable: -32013,
    });
  });

  it("marks only runtime_owned as retryable", () => {
    expect(isRetryableRecoveryReason("runtime_owned")).toBe(true);
    expect(isRetryableRecoveryReason("session_not_found")).toBe(false);
    expect(isRetryableRecoveryReason("recovery_unavailable")).toBe(false);
    expect(isRetryableRecoveryReason("recovery_failed")).toBe(false);
    expect(isRetryableRecoveryReason("workspace_unavailable")).toBe(false);
    expect(isRetryableRecoveryReason("provider_configuration_missing")).toBe(false);
  });

  it("computes retryAfterMs from a future lease expiry", () => {
    const now = new Date("2026-08-11T12:00:00.000Z").getTime();
    const lease = "2026-08-11T12:05:00.000Z";
    expect(computeLeaseRetryAfterMs(lease, now)).toBe(300_000);
  });

  it("clamps retryAfterMs to zero once the lease has expired", () => {
    const now = new Date("2026-08-11T12:00:00.000Z").getTime();
    expect(computeLeaseRetryAfterMs("2026-08-11T11:59:00.000Z", now)).toBe(0);
    expect(computeLeaseRetryAfterMs(undefined, now)).toBeUndefined();
    expect(computeLeaseRetryAfterMs("not-a-date", now)).toBeUndefined();
  });

  it("builds a structured runtime_owned error with lease hints", () => {
    const now = new Date("2026-08-11T12:00:00.000Z").getTime();
    const lease = new Date(now + 120_000).toISOString();
    const error = buildRuntimeOwnedError("Session is owned", {
      executionMode: "embedded",
      ownerInstanceId: "next-4242",
      leaseExpiresAt: lease,
    });

    expect(error.code).toBe(RECOVERY_JSON_RPC_CODES.runtimeOwned);
    expect(error.message).toBe("Session is owned");
    expect(error.data).toMatchObject({
      reason: "runtime_owned",
      retryable: true,
      ownerInstanceId: "next-4242",
      leaseExpiresAt: lease,
    });
    expect(error.data?.retryAfterMs).toBeTypeOf("number");
  });

  it("builds a non-retryable session_not_found error", () => {
    const error = buildSessionNotFoundError("session-x");
    expect(error.code).toBe(RECOVERY_JSON_RPC_CODES.sessionNotFound);
    expect(error.data).toEqual({
      reason: "session_not_found",
      retryable: false,
    });
  });

  it("builds recovery error data with extras", () => {
    expect(buildRecoveryErrorData("recovery_failed")).toEqual({
      reason: "recovery_failed",
      retryable: false,
    });
    expect(buildRecoveryErrorData("runtime_owned", { ownerInstanceId: "next-1" }))
      .toMatchObject({ reason: "runtime_owned", retryable: true, ownerInstanceId: "next-1" });
  });

  // ── P1-2: Team binding restoration failures are structured + actionable ──
  it("builds a NON-retryable missing_team_metadata error carrying the missing fields", () => {
    const error = buildTeamBindingsFailedError("session-9", {
      code: "missing_team_metadata",
      message: "missing team metadata",
      missingMetadata: ["routaAgentId"],
    });

    expect(error.code).toBe(RECOVERY_JSON_RPC_CODES.recoveryFailed);
    expect(error.data).toMatchObject({
      reason: "recovery_failed",
      retryable: false,
      failure: "missing_team_metadata",
      sessionId: "session-9",
    });
    // The structured payload tells the UI exactly which metadata is absent.
    expect(error.data?.missingMetadata).toEqual(["routaAgentId"]);
  });

  it("builds a retryable team_bindings_incomplete error carrying the failed bindings", () => {
    const error = buildTeamBindingsFailedError("session-9", {
      code: "team_bindings_incomplete",
      message: "store offline",
      missingBindings: ["child_session_mappings"],
    });

    expect(error.code).toBe(RECOVERY_JSON_RPC_CODES.recoveryFailed);
    expect(error.data).toMatchObject({
      reason: "recovery_failed",
      retryable: true,
      failure: "team_bindings_incomplete",
      sessionId: "session-9",
    });
    expect(error.data?.missingBindings).toEqual(["child_session_mappings"]);
  });
});
