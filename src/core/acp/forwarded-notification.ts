/**
 * Forwarded provider notifications: push a provider `session/update` into the
 * live HTTP session store AND persist it into the durable session history
 * write buffer.
 *
 * Extracted from `src/app/api/acp/route.ts` so core recovery paths (Team
 * runtime restoration in particular) can reuse the exact same
 * push+persist semantics without growing the route file.
 */

import { getHttpSessionStore, type SessionUpdateNotification } from "@/core/acp/http-session-store";
import { getSessionWriteBuffer } from "@/core/acp/session-history";

/**
 * Terminal/semantically-final updates flush the write buffer immediately so
 * durable history catches up at turn boundaries instead of waiting for the
 * periodic flush.
 */
export function shouldFlushForwardedSessionUpdate(
  notification: SessionUpdateNotification,
): boolean {
  const update = notification.update as Record<string, unknown> | undefined;
  const sessionUpdate = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : undefined;
  if (!sessionUpdate) return false;

  if (
    sessionUpdate === "turn_complete"
    || sessionUpdate === "task_completion"
    || sessionUpdate === "completed"
    || sessionUpdate === "ended"
    || sessionUpdate === "error"
  ) {
    return true;
  }

  if (sessionUpdate === "tool_call_update") {
    const status = typeof update?.status === "string" ? update.status : undefined;
    return status === "completed" || status === "failed";
  }

  return false;
}

export function pushAndPersistForwardedNotification(
  store: ReturnType<typeof getHttpSessionStore>,
  sessionId: string,
  data: unknown,
): void {
  const notification = {
    ...(data as Record<string, unknown>),
    sessionId,
  } as SessionUpdateNotification;

  store.pushNotification(notification);

  const buffer = getSessionWriteBuffer();
  buffer.add(sessionId, notification);
  if (shouldFlushForwardedSessionUpdate(notification)) {
    void buffer.flush(sessionId);
  }
}
