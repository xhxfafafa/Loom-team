import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Task } from "@/core/models/task";
import {
  collectTeamTreeSessionIds,
  deleteUnassignedHistoricalCards,
  findUnassignedHistoricalCardIds,
  previewUnassignedHistoricalCards,
  type UnassignedCardsPorts,
  type UnassignedCardsSessionShape,
} from "../unassigned-team-cards";

const driverRef = vi.hoisted(() => ({ current: "memory" as "memory" | "sqlite" | "postgres" }));

const sqliteState = vi.hoisted(() => ({
  transactionCalls: 0,
  deletedTables: [] as string[],
}));

const pgState = vi.hoisted(() => ({
  batchCalls: 0,
  transactionCalls: 0,
  deletedTables: [] as unknown[],
}));

vi.mock("@/core/db/index", () => ({
  getDatabaseDriver: () => driverRef.current,
  getPostgresDatabase: () => ({
    delete: (table: unknown) => {
      pgState.deletedTables.push(table);
      return { where: () => ({ table }) };
    },
    batch: async (statements: unknown[]) => {
      pgState.batchCalls += 1;
      void statements;
    },
    transaction: async (callback: (tx: unknown) => Promise<void>) => {
      pgState.transactionCalls += 1;
      await callback({
        delete: (table: unknown) => {
          pgState.deletedTables.push(table);
          return { where: () => undefined };
        },
      });
    },
  }),
}));

vi.mock("@/core/db/sqlite", () => ({
  getSqliteDatabase: () => ({
    transaction: (callback: (tx: unknown) => void) => {
      sqliteState.transactionCalls += 1;
      callback({
        delete: (table: string) => {
          sqliteState.deletedTables.push(table);
          return { where: () => ({ run: () => {} }) };
        },
      });
    },
  }),
}));

vi.mock("@/core/db/sqlite-schema", () => ({
  tasks: "sqlite.tasks",
}));

// ─── Fixtures ────────────────────────────────────────────────────────────

function sessionShape(
  sessionId: string,
  extra: Partial<UnassignedCardsSessionShape> = {},
): UnassignedCardsSessionShape {
  return { sessionId, workspaceId: "ws-1", parentSessionId: undefined, ...extra };
}

function teamSessions(): UnassignedCardsSessionShape[] {
  return [
    sessionShape("root-1", { specialistId: "team-agent-lead", name: "Team - Alpha" }),
    sessionShape("child-1", { parentSessionId: "root-1" }),
    sessionShape("grandchild-1", { parentSessionId: "child-1" }),
    sessionShape("solo-1", { role: "claude", name: "Regular session" }),
    // Team in another workspace must never affect this one.
    sessionShape("root-2", { specialistId: "team-agent-lead", workspaceId: "ws-2" }),
    sessionShape("child-2", { parentSessionId: "root-2", workspaceId: "ws-2" }),
  ];
}

function task(id: string, extra: Partial<Task> = {}): Task {
  return { id, workspaceId: "ws-1", ...extra } as unknown as Task;
}

interface DeleteTracker {
  deleted: string[];
  notified: string[];
}

function createPorts(
  sessions: UnassignedCardsSessionShape[],
  tasks: Task[],
  tracker?: DeleteTracker,
): UnassignedCardsPorts {
  const store = tracker ?? { deleted: [], notified: [] };
  return {
    listSessions: () => sessions,
    taskStore: {
      listByWorkspace: async (workspaceId: string) =>
        tasks.filter((entry) => entry.workspaceId === workspaceId),
      delete: async (id: string) => {
        store.deleted.push(id);
      },
    },
    notifyTaskDeleted: (_workspaceId, taskId) => {
      store.notified.push(taskId);
    },
  };
}

beforeEach(() => {
  driverRef.current = "memory";
  sqliteState.transactionCalls = 0;
  sqliteState.deletedTables = [];
  pgState.batchCalls = 0;
  pgState.transactionCalls = 0;
  pgState.deletedTables = [];
});

// ─── Pure helpers ────────────────────────────────────────────────────────

describe("collectTeamTreeSessionIds", () => {
  it("covers every session of existing team trees in the workspace only", () => {
    const covered = collectTeamTreeSessionIds(teamSessions(), "ws-1");

    expect(covered).toEqual(new Set(["root-1", "child-1", "grandchild-1"]));
  });
});

describe("findUnassignedHistoricalCardIds", () => {
  it("selects only teamRunId-less cards with no team-tree linkage", () => {
    const covered = collectTeamTreeSessionIds(teamSessions(), "ws-1");
    const tasks = [
      // Explicitly owned → not unassigned.
      task("task-owned", { teamRunId: "root-1" }),
      // Owned by another team → not unassigned.
      task("task-other-team", { teamRunId: "root-2" }),
      // No teamRunId but linked into the team tree → ambiguous, keep.
      task("task-legacy-linked", { triggerSessionId: "child-1" }),
      // No teamRunId, linked to a normal session → unassigned.
      task("task-normal-linked", { sessionId: "solo-1" }),
      // No teamRunId, no links at all → unassigned.
      task("task-orphan"),
      // Stale link to a nonexistent session → still unassigned.
      task("task-stale", { sessionIds: ["ghost-session"] }),
    ];

    expect(findUnassignedHistoricalCardIds(tasks, covered)).toEqual([
      "task-normal-linked",
      "task-orphan",
      "task-stale",
    ]);
  });
});

// ─── Preview ─────────────────────────────────────────────────────────────

describe("previewUnassignedHistoricalCards", () => {
  it("lists unassigned cards without mutating anything", async () => {
    const tracker = { deleted: [], notified: [] };
    const ports = createPorts(
      teamSessions(),
      [
        task("task-orphan"),
        task("task-owned", { teamRunId: "root-1" }),
        task("task-legacy-linked", { triggerSessionId: "grandchild-1" }),
      ],
      tracker,
    );

    const preview = await previewUnassignedHistoricalCards(ports, "ws-1");

    expect(preview).toEqual({ workspaceId: "ws-1", taskIds: ["task-orphan"] });
    expect(tracker.deleted).toEqual([]);
    expect(tracker.notified).toEqual([]);
  });
});

// ─── Deletion ────────────────────────────────────────────────────────────

describe("deleteUnassignedHistoricalCards", () => {
  it("deletes only unassigned cards and notifies per deleted card", async () => {
    const tracker = { deleted: [], notified: [] };
    const ports = createPorts(
      teamSessions(),
      [
        task("task-orphan"),
        task("task-normal-linked", { sessionId: "solo-1" }),
        task("task-owned", { teamRunId: "root-1" }),
        task("task-legacy-linked", { sessionIds: ["root-1"] }),
      ],
      tracker,
    );

    const result = await deleteUnassignedHistoricalCards(ports, "ws-1");

    expect(new Set(result.deletedTaskIds)).toEqual(
      new Set(["task-orphan", "task-normal-linked"]),
    );
    expect(new Set(tracker.deleted)).toEqual(
      new Set(["task-orphan", "task-normal-linked"]),
    );
    expect(new Set(tracker.notified)).toEqual(
      new Set(["task-orphan", "task-normal-linked"]),
    );
  });

  it("keeps every card once it gains team linkage or ownership", async () => {
    const tracker = { deleted: [], notified: [] };
    const ports = createPorts(
      teamSessions(),
      [
        task("task-owned", { teamRunId: "root-1" }),
        task("task-legacy-linked", { laneSessions: [{ sessionId: "child-1" }] } as Partial<Task>),
      ],
      tracker,
    );

    const result = await deleteUnassignedHistoricalCards(ports, "ws-1");

    expect(result.deletedTaskIds).toEqual([]);
    expect(tracker.deleted).toEqual([]);
    expect(tracker.notified).toEqual([]);
  });

  it("scopes strictly to the requested workspace", async () => {
    const tracker = { deleted: [], notified: [] };
    const ports = createPorts(
      teamSessions(),
      [
        task("task-orphan-ws1"),
        { ...task("task-orphan-ws2"), workspaceId: "ws-2" } as Task,
      ],
      tracker,
    );

    const result = await deleteUnassignedHistoricalCards(ports, "ws-1");

    expect(result.deletedTaskIds).toEqual(["task-orphan-ws1"]);
    expect(tracker.deleted).toEqual(["task-orphan-ws1"]);
  });

  it("routes sqlite deletions through a single transaction on the tasks table", async () => {
    driverRef.current = "sqlite";
    const tracker = { deleted: [], notified: [] };
    const ports = createPorts(teamSessions(), [task("task-orphan")], tracker);

    const result = await deleteUnassignedHistoricalCards(ports, "ws-1");

    expect(result.deletedTaskIds).toEqual(["task-orphan"]);
    expect(sqliteState.transactionCalls).toBe(1);
    expect(sqliteState.deletedTables).toEqual(["sqlite.tasks"]);
    // Persistent drivers bypass the in-memory store for the delete itself.
    expect(tracker.deleted).toEqual([]);
    expect(tracker.notified).toEqual(["task-orphan"]);
  });

  it("routes postgres-js deletions through an interactive transaction", async () => {
    driverRef.current = "postgres";
    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://localhost:5432/routa";
    try {
      const tracker = { deleted: [], notified: [] };
      const ports = createPorts(teamSessions(), [task("task-orphan")], tracker);

      const result = await deleteUnassignedHistoricalCards(ports, "ws-1");

      expect(result.deletedTaskIds).toEqual(["task-orphan"]);
      expect(pgState.transactionCalls).toBe(1);
      expect(pgState.batchCalls).toBe(0);
      expect(tracker.notified).toEqual(["task-orphan"]);
    } finally {
      process.env.DATABASE_URL = previousUrl;
    }
  });

  it("sends neon-http deletions as one atomic batch", async () => {
    driverRef.current = "postgres";
    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://user@ep-abc.eu-central-1.aws.neon.tech/routa";
    try {
      const ports = createPorts(teamSessions(), [task("task-orphan")]);

      const result = await deleteUnassignedHistoricalCards(ports, "ws-1");

      expect(result.deletedTaskIds).toEqual(["task-orphan"]);
      expect(pgState.batchCalls).toBe(1);
      expect(pgState.transactionCalls).toBe(0);
    } finally {
      process.env.DATABASE_URL = previousUrl;
    }
  });
});
