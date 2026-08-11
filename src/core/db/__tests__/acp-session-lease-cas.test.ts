import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AcpSession, AcpSessionStore } from "@/core/store/acp-session-store";
import { InMemoryAcpSessionStore } from "@/core/store/acp-session-store";

import * as sqliteSchema from "../sqlite-schema";
import { SqliteAcpSessionStore } from "../sqlite-stores";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const ACTIVE_LEASE = new Date(NOW.getTime() + 300_000).toISOString();
const EXPIRED_LEASE = new Date(NOW.getTime() - 1_000).toISOString();
const NEW_LEASE = new Date(NOW.getTime() + 300_000).toISOString();

function makeSession(overrides: Partial<AcpSession> = {}): AcpSession {
  return {
    id: "session-lease",
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

/**
 * The same lease compare-and-swap contract must hold for every store backend:
 * acquire only when unowned, leaseless, expired, or already owned by the
 * requesting instance — never read-then-save, never clobber durable fields.
 */
function leaseCasContract(getStore: () => AcpSessionStore) {
  it("acquires a session with no owner or lease", async () => {
    const store = getStore();
    const acquired = await store.tryAcquireExpiredLease(
      "session-lease",
      { ownerInstanceId: "instance-a", leaseExpiresAt: NEW_LEASE, executionMode: "embedded" },
      NOW,
    );

    expect(acquired).toBe(true);
    const session = await store.get("session-lease");
    expect(session?.ownerInstanceId).toBe("instance-a");
    expect(session?.leaseExpiresAt).toBe(NEW_LEASE);
    expect(session?.executionMode).toBe("embedded");
  });

  it("refuses to acquire while another instance holds an active lease", async () => {
    const store = getStore();
    await store.tryAcquireExpiredLease(
      "session-lease",
      { ownerInstanceId: "instance-a", leaseExpiresAt: ACTIVE_LEASE, executionMode: "embedded" },
      NOW,
    );

    const acquired = await store.tryAcquireExpiredLease(
      "session-lease",
      { ownerInstanceId: "instance-b", leaseExpiresAt: NEW_LEASE, executionMode: "embedded" },
      NOW,
    );

    expect(acquired).toBe(false);
    const session = await store.get("session-lease");
    expect(session?.ownerInstanceId).toBe("instance-a");
    expect(session?.leaseExpiresAt).toBe(ACTIVE_LEASE);
  });

  it("acquires a session whose foreign lease has expired", async () => {
    const store = getStore();
    await store.tryAcquireExpiredLease(
      "session-lease",
      { ownerInstanceId: "dead-instance", leaseExpiresAt: EXPIRED_LEASE, executionMode: "embedded" },
      NOW,
    );

    const acquired = await store.tryAcquireExpiredLease(
      "session-lease",
      { ownerInstanceId: "instance-b", leaseExpiresAt: NEW_LEASE, executionMode: "embedded" },
      NOW,
    );

    expect(acquired).toBe(true);
    const session = await store.get("session-lease");
    expect(session?.ownerInstanceId).toBe("instance-b");
    expect(session?.leaseExpiresAt).toBe(NEW_LEASE);
  });

  it("lets the owning instance refresh its own active lease", async () => {
    const store = getStore();
    await store.tryAcquireExpiredLease(
      "session-lease",
      { ownerInstanceId: "instance-a", leaseExpiresAt: ACTIVE_LEASE, executionMode: "embedded" },
      NOW,
    );

    const refreshedLease = new Date(NOW.getTime() + 600_000).toISOString();
    const refreshed = await store.tryAcquireExpiredLease(
      "session-lease",
      { ownerInstanceId: "instance-a", leaseExpiresAt: refreshedLease },
      NOW,
    );

    expect(refreshed).toBe(true);
    const session = await store.get("session-lease");
    expect(session?.ownerInstanceId).toBe("instance-a");
    expect(session?.leaseExpiresAt).toBe(refreshedLease);
  });

  it("returns false for an unknown session", async () => {
    const store = getStore();
    const acquired = await store.tryAcquireExpiredLease(
      "missing-session",
      { ownerInstanceId: "instance-a", leaseExpiresAt: NEW_LEASE },
      NOW,
    );
    expect(acquired).toBe(false);
  });

  it("never touches durable identity fields (routa_agent_id, provider_session_id, history)", async () => {
    const store = getStore();
    await store.appendHistory("session-lease", {
      sessionId: "session-lease",
      eventId: "event-1",
      update: { sessionUpdate: "user_message", content: "hello" },
    });

    await store.tryAcquireExpiredLease(
      "session-lease",
      { ownerInstanceId: "instance-a", leaseExpiresAt: NEW_LEASE, executionMode: "embedded" },
      NOW,
    );

    const session = await store.get("session-lease");
    expect(session?.routaAgentId).toBe("routa-agent-durable");
    expect(session?.providerSessionId).toBe("provider-native-1");
    expect(session?.firstPromptSent).toBe(true);
    expect(session?.messageHistory).toHaveLength(1);
  });
}

describe("InMemoryAcpSessionStore lease CAS", () => {
  let store: InMemoryAcpSessionStore;

  beforeEach(async () => {
    store = new InMemoryAcpSessionStore();
    await store.save(makeSession());
  });

  leaseCasContract(() => store);
});

describe("SqliteAcpSessionStore lease CAS", () => {
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

  leaseCasContract(() => store);

  it("persists the acquired lease through a single conditional UPDATE", async () => {
    await store.save(makeSession());

    await store.tryAcquireExpiredLease(
      "session-lease",
      { ownerInstanceId: "instance-a", leaseExpiresAt: NEW_LEASE, executionMode: "embedded" },
      NOW,
    );

    const row = sqlite.prepare(`
      SELECT owner_instance_id AS ownerInstanceId,
             lease_expires_at AS leaseExpiresAt,
             execution_mode AS executionMode,
             routa_agent_id AS routaAgentId,
             provider_session_id AS providerSessionId
      FROM acp_sessions WHERE id = ?
    `).get("session-lease") as {
      ownerInstanceId: string;
      leaseExpiresAt: number;
      executionMode: string;
      routaAgentId: string;
      providerSessionId: string;
    };
    expect(row.ownerInstanceId).toBe("instance-a");
    expect(row.leaseExpiresAt).toBe(new Date(NEW_LEASE).getTime());
    expect(row.executionMode).toBe("embedded");
    expect(row.routaAgentId).toBe("routa-agent-durable");
    expect(row.providerSessionId).toBe("provider-native-1");
  });
});
