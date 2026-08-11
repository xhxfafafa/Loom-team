import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AcpSession, AcpSessionStore } from "@/core/store/acp-session-store";
import { InMemoryAcpSessionStore } from "@/core/store/acp-session-store";

import * as sqliteSchema from "../sqlite-schema";
import { SqliteAcpSessionStore } from "../sqlite-stores";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function makeSession(overrides: Partial<AcpSession> = {}): AcpSession {
  return {
    id: "session-history",
    cwd: "/tmp/project",
    workspaceId: "workspace-1",
    routaAgentId: "routa-agent-durable",
    providerSessionId: "provider-native-1",
    provider: "codex",
    firstPromptSent: true,
    messageHistory: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function deliveryNotification(sessionId: string, eventId: string, text: string) {
  return {
    sessionId,
    eventId,
    update: { sessionUpdate: "user_message", content: { type: "text", text } },
  };
}

/**
 * The same idempotent-append contract must hold for every store backend:
 * append exactly once per event ID (check + append in one transaction),
 * never touch durable identity fields, and report membership truthfully.
 *
 * The result is a STRUCTURED status, never a bare boolean: callers must be
 * able to distinguish a true duplicate from a missing session, and a DB
 * failure must surface as an exception (fail-closed) instead of masquerading
 * as either.
 */
function appendHistoryOnceContract(getStore: () => AcpSessionStore) {
  it("appends a new event once and reports it as present", async () => {
    const store = getStore();

    const appended = await store.appendHistoryOnce(
      "session-history",
      "team-report:parent:child:task-1:0",
      deliveryNotification("session-history", "team-report:parent:child:task-1:0", "report"),
    );

    expect(appended).toBe("appended");
    expect(await store.hasHistoryEvent("session-history", "team-report:parent:child:task-1:0")).toBe(true);
    const history = await store.getHistory("session-history");
    expect(history).toHaveLength(1);
    expect(history[0].eventId).toBe("team-report:parent:child:task-1:0");
  });

  it("refuses to append the same event ID twice (duplicate delivery)", async () => {
    const store = getStore();

    const first = await store.appendHistoryOnce(
      "session-history",
      "delivery-1",
      deliveryNotification("session-history", "delivery-1", "report"),
    );
    const second = await store.appendHistoryOnce(
      "session-history",
      "delivery-1",
      deliveryNotification("session-history", "delivery-1", "report again"),
    );

    expect(first).toBe("appended");
    expect(second).toBe("duplicate");
    const history = await store.getHistory("session-history");
    expect(history).toHaveLength(1);
    // The first recorded delivery wins; retries never replace it.
    expect((history[0].update as { content: { text: string } }).content.text).toBe("report");
  });

  it("keeps distinct event IDs in order with sequential message indexes", async () => {
    const store = getStore();

    await store.appendHistoryOnce("session-history", "event-a", deliveryNotification("session-history", "event-a", "a"));
    await store.appendHistoryOnce("session-history", "event-b", deliveryNotification("session-history", "event-b", "b"));

    const history = await store.getHistory("session-history");
    expect(history.map((entry) => entry.eventId)).toEqual(["event-a", "event-b"]);
  });

  it("reports unknown sessions as session_not_found, distinct from duplicate", async () => {
    const store = getStore();

    const appended = await store.appendHistoryOnce(
      "missing-session",
      "event-a",
      deliveryNotification("missing-session", "event-a", "a"),
    );

    expect(appended).toBe("session_not_found");
    expect(await store.hasHistoryEvent("missing-session", "event-a")).toBe(false);
  });

  it("never touches durable identity fields (routa_agent_id, provider_session_id)", async () => {
    const store = getStore();

    await store.appendHistoryOnce(
      "session-history",
      "delivery-1",
      deliveryNotification("session-history", "delivery-1", "report"),
    );

    const session = await store.get("session-history");
    expect(session?.routaAgentId).toBe("routa-agent-durable");
    expect(session?.providerSessionId).toBe("provider-native-1");
    expect(session?.firstPromptSent).toBe(true);
  });

  it("treats legacy JSON-only history event IDs as already delivered", async () => {
    const store = getStore();
    // A legacy session whose history only lives in the JSON column.
    await store.save(makeSession({
      id: "session-legacy",
      messageHistory: [deliveryNotification("session-legacy", "legacy-event", "old")],
    }));

    const appended = await store.appendHistoryOnce(
      "session-legacy",
      "legacy-event",
      deliveryNotification("session-legacy", "legacy-event", "duplicate"),
    );

    expect(appended).toBe("duplicate");
    expect(await store.hasHistoryEvent("session-legacy", "legacy-event")).toBe(true);
  });
}

describe("InMemoryAcpSessionStore appendHistoryOnce", () => {
  let store: InMemoryAcpSessionStore;

  beforeEach(async () => {
    store = new InMemoryAcpSessionStore();
    await store.save(makeSession());
  });

  appendHistoryOnceContract(() => store);
});

describe("SqliteAcpSessionStore appendHistoryOnce", () => {
  let sqlite: BetterSqlite3.Database;
  let store: SqliteAcpSessionStore;

  beforeEach(async () => {
    sqlite = new BetterSqlite3(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        metadata TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE acp_sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        cwd TEXT NOT NULL,
        branch TEXT,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        routa_agent_id TEXT,
        provider_session_id TEXT,
        provider TEXT,
        role TEXT,
        mode_id TEXT,
        model TEXT,
        first_prompt_sent INTEGER DEFAULT 0,
        message_history TEXT DEFAULT '[]',
        parent_session_id TEXT,
        specialist_id TEXT,
        team_chain_id TEXT,
        execution_mode TEXT,
        owner_instance_id TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE session_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES acp_sessions(id) ON DELETE CASCADE,
        message_index INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );
    `);
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO workspaces (id, title, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("workspace-1", "Workspace One", "active", "{}", now, now);

    store = new SqliteAcpSessionStore(drizzle(sqlite, { schema: sqliteSchema }));
    await store.save(makeSession());
  });

  afterEach(() => {
    sqlite.close();
  });

  appendHistoryOnceContract(() => store);

  it("propagates DB failures instead of collapsing them into a duplicate/false result", async () => {
    // A closed database simulates an unavailable persistence layer. The store
    // must throw (fail-closed) so callers can distinguish "unavailable" from
    // "duplicate" — a swallowed error would let the prompt path treat a lost
    // write as an already-delivered prompt.
    sqlite.close();

    await expect(
      store.appendHistoryOnce(
        "session-history",
        "event-after-close",
        deliveryNotification("session-history", "event-after-close", "a"),
      ),
    ).rejects.toThrow();
  });

  it("persists the event row keyed by event ID through one transaction", async () => {
    await store.appendHistoryOnce(
      "session-history",
      "team-report:parent:child:task-1:0",
      deliveryNotification("session-history", "team-report:parent:child:task-1:0", "report"),
    );

    const row = sqlite.prepare(`
      SELECT id, session_id AS sessionId, message_index AS messageIndex, event_type AS eventType
      FROM session_messages WHERE id = ?
    `).get("team-report:parent:child:task-1:0") as {
      id: string;
      sessionId: string;
      messageIndex: number;
      eventType: string;
    };
    expect(row.sessionId).toBe("session-history");
    expect(row.messageIndex).toBe(0);
    expect(row.eventType).toBe("user_message");
  });
});
