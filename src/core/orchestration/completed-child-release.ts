/**
 * Completed-child runtime release.
 *
 * When a Team child session finishes and its completion report receipt is
 * durable in the parent history, its provider runtime may be reclaimed. The
 * decision runs through the shared session runtime finalizer, which owns the
 * safety gates (feature flag, Lead role protection, streaming, pending
 * interaction, active descendants, recovery readiness, durable receipt, and
 * history/trace persistence before any kill).
 */

/**
 * Release a completed child's provider runtime through the shared session
 * runtime finalizer, only after its completion report receipt is durable.
 * Best-effort by design: a skipped or failed release keeps the Session and
 * history intact and retries on the next completion, disconnect,
 * memory-cleanup, or shutdown trigger — it never deletes history or fakes
 * success.
 */
export async function releaseCompletedChildRuntime(childSessionId: string): Promise<void> {
  try {
    const { finalizeSessionRuntime } = await import("@/core/acp/session-runtime-finalizer");
    const release = await finalizeSessionRuntime(childSessionId, "completed");
    if (release.released) {
      console.info(`[TeamRuntime] Released completed child runtime ${childSessionId}`);
      return;
    }
    const detail = release.skipReason
      ?? (release.errors.length > 0 ? release.errors.join("; ") : "release-incomplete");
    console.info(`[TeamRuntime] Kept completed child runtime ${childSessionId} (skip: ${detail})`);
  } catch (err) {
    console.error(
      `[TeamRuntime] Completed child runtime release failed for ${childSessionId}; session retained for retry`,
      err,
    );
  }
}
