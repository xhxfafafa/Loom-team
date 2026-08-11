/**
 * SQLite ACP session history — idempotent, transactional event appends.
 *
 * Extracted from `sqlite-stores.ts` to keep the store module focused on CRUD;
 * the atomic check-and-append semantics here back the at-least-once team
 * report delivery contract (see `src/core/orchestration/team-report-delivery.ts`).
 */

import { and, desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as sqliteSchema from "./sqlite-schema";
import type { AcpSessionNotification, AppendHistoryOnceStatus } from "../store/acp-session-store";
import { compactSessionNotificationForPersistence } from "../acp/session-notification-retention";

type SqliteDb = BetterSQLite3Database<typeof sqliteSchema>;

/**
 * Atomically check-and-append one history event. Returns a structured status:
 * `"appended"` when newly recorded, `"duplicate"` when the event ID is already
 * present (in the `session_messages` table or the legacy JSON column), and
 * `"session_not_found"` when the session row is missing. The existence check
 * and the append run inside ONE transaction, so a duplicated delivery can
 * never interleave and append twice. Storage failures THROW — callers must be
 * able to tell an unavailable DB apart from a duplicate delivery.
 */
export function appendSessionHistoryEventOnce(
  db: SqliteDb,
  sessionId: string,
  eventId: string,
  notification: AcpSessionNotification,
): AppendHistoryOnceStatus {
  return db.transaction((tx) => {
    const existing = tx
      .select({ id: sqliteSchema.sessionMessages.id })
      .from(sqliteSchema.sessionMessages)
      .where(and(
        eq(sqliteSchema.sessionMessages.sessionId, sessionId),
        eq(sqliteSchema.sessionMessages.id, eventId),
      ))
      .limit(1)
      .all();
    if (existing.length > 0) return "duplicate";

    const sessionRows = tx
      .select()
      .from(sqliteSchema.acpSessions)
      .where(eq(sqliteSchema.acpSessions.id, sessionId))
      .limit(1)
      .all();
    if (sessionRows.length === 0) return "session_not_found";

    // Legacy sessions may only carry history in the JSON column; honour
    // event IDs already present there too.
    const legacyHistory = sessionRows[0].messageHistory ?? [];
    if (legacyHistory.some((entry) => entry.eventId === eventId)) {
      return "duplicate";
    }

    const persistedNotification = compactSessionNotificationForPersistence({
      ...notification,
      eventId,
    });

    const nextIndexRows = tx
      .select({ messageIndex: sqliteSchema.sessionMessages.messageIndex })
      .from(sqliteSchema.sessionMessages)
      .where(eq(sqliteSchema.sessionMessages.sessionId, sessionId))
      .orderBy(desc(sqliteSchema.sessionMessages.messageIndex))
      .limit(1)
      .all();
    const nextIndex = nextIndexRows.length > 0 ? nextIndexRows[0].messageIndex + 1 : 0;
    const eventType = String(
      (persistedNotification.update as Record<string, unknown> | undefined)?.sessionUpdate ?? "notification",
    );

    tx.insert(sqliteSchema.sessionMessages)
      .values({
        id: eventId,
        sessionId,
        messageIndex: nextIndex,
        eventType,
        payload: persistedNotification as typeof sqliteSchema.sessionMessages.$inferInsert.payload,
      })
      .run();

    tx.update(sqliteSchema.acpSessions)
      .set({ messageHistory: [...legacyHistory, persistedNotification], updatedAt: new Date() })
      .where(eq(sqliteSchema.acpSessions.id, sessionId))
      .run();

    return "appended";
  });
}
