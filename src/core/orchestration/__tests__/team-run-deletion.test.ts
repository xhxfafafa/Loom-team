import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as pgSchema from "@/core/db/schema";
import type { Task } from "@/core/models/task";
import type { Worktree } from "@/core/models/worktree";
import {
  buildTeamRunDeletionPlan,
  deleteTeamRun,
  TeamRunDeletionError,
  type TeamRunDeletionPorts,
  type TeamRunSessionRecord,
} from "../team-run-deletion";

const driverRef = vi.hoisted(() => ({ current: "memory" as "memory" | "sqlite" | "postgres" }));

const sqliteState = vi.hoisted(() => ({
  transactionCalls: 0,
  deletedTables: [] as string[],
}));

const pgState = vi.hoisted(() => ({
  batchCalls: 0,
  batchedStatements: 0,
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
      pgState.batchedStatements = statements.length;
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
  artifacts: "sqlite.artifacts",
  artifactRequests: "sqlite.artifactRequests",
  backgroundTasks: "sqlite.backgroundTasks",
  notes: "sqlite.notes",
  worktrees: "sqlite.worktrees",
  sessionMessages: "sqlite.sessionMessages",
  acpSessions: "sqlite.acpSessions",
}));

// ─── Fixtures ────────────────────────────────────────────────────────────

interface TaskFixture {
  id: string;
  sessionId?: string;
  triggerSessionId?: string;
  sessionIds?: string[];
  laneSessions?: Array<{ sessionId?: string; worktreeId?: string }>;
  worktreeId?: string;
}

interface WorktreeFixture {
  id: string;
  sessionId?: string;
}

interface NoteFixture {
  id: string;
  sessionId?: string;
  metadata?: { parentNoteId?: string };
}

interface FixtureOptions {
  sessions?: TeamRunSessionRecord[];
  tasks?: TaskFixture[];
  artifactsByTask?: Record<string, string[]>;
  worktrees?: WorktreeFixture[];
  notes?: NoteFixture[];
  backgroundTasks?: Array<{ id: string; resultSessionId?: string }>;
  activeSessionIds?: string[];
}

function teamSession(
  sessionId: string,
  extra: Partial<TeamRunSessionRecord> = {},
): TeamRunSessionRecord {
  return {
    sessionId,
    name: sessionId === "root-1" ? "Team - Alpha" : sessionId,
    role: "ROUTA",
    cwd: "/tmp/project",
    workspaceId: "ws-1",
    parentSessionId: undefined,
    ...extra,
  };
}

function defaultTeamSessions(): TeamRunSessionRecord[] {
  return [
    teamSession("root-1"),
    teamSession("child-1", { parentSessionId: "root-1", name: "worker-1" }),
    teamSession("grandchild-1", { parentSessionId: "child-1", name: "worker-1-1" }),
    teamSession("outsider-1", { name: "Regular session", role: "claude" }),
  ];
}

function createPorts(options: FixtureOptions, events: string[] = []): TeamRunDeletionPorts {
  const active = new Set(options.activeSessionIds ?? []);
  const artifactsByTask = options.artifactsByTask ?? {};
  const deleted: {
    tasks: string[];
    artifactsByTask: string[];
    worktrees: string[];
    notes: string[];
    backgroundTasks: string[];
  } = { tasks: [], artifactsByTask: [], worktrees: [], notes: [], backgroundTasks: [] };

  const ports = {
    listSessions: () => options.sessions ?? [],
    hasActiveProcess: (sessionId: string) => active.has(sessionId),
    killSessionProcess: async (sessionId: string) => {
      events.push(`kill:${sessionId}`);
      active.delete(sessionId);
    },
    system: {
      taskStore: {
        listByWorkspace: async () => options.tasks ?? [],
        delete: async (id: string) => {
          events.push(`store:task:${id}`);
          deleted.tasks.push(id);
        },
      },
      artifactStore: {
        listByTask: async (taskId: string) =>
          (artifactsByTask[taskId] ?? []).map((id) => ({ id, taskId })),
        deleteByTask: async (taskId: string) => {
          events.push(`store:artifacts-of:${taskId}`);
          deleted.artifactsByTask.push(taskId);
        },
      },
      worktreeStore: {
        listByWorkspace: async () => options.worktrees ?? [],
        remove: async (id: string) => {
          events.push(`store:worktree:${id}`);
          deleted.worktrees.push(id);
        },
      },
      noteStore: {
        listByWorkspace: async () => options.notes ?? [],
        delete: async (id: string) => {
          events.push(`store:note:${id}`);
          deleted.notes.push(id);
        },
      },
      backgroundTaskStore: {
        listByWorkspace: async () => options.backgroundTasks ?? [],
        delete: async (id: string) => {
          events.push(`store:background-task:${id}`);
          deleted.backgroundTasks.push(id);
        },
      },
    },
    clearInMemorySession: (sessionId: string) => {
      events.push(`clear-in-memory:${sessionId}`);
    },
    deleteLocalSessionFile: async (_cwd: string, sessionId: string) => {
      events.push(`local-file:${sessionId}`);
    },
    removeWorktreeDirectory: async (worktree: Worktree) => {
      events.push(`worktree-fs:${worktree.id}`);
    },
    notifyTaskDeleted: (_workspaceId: string, taskId: string) => {
      events.push(`kanban-event:${taskId}`);
    },
    _deleted: deleted,
    _active: active,
  };

  return ports as unknown as TeamRunDeletionPorts;
}

function taskFixture(fixture: TaskFixture): Task {
  return fixture as unknown as Task;
}

function worktreeFixture(fixture: WorktreeFixture): Worktree {
  return {
    id: fixture.id,
    sessionId: fixture.sessionId,
    codebaseId: "codebase-1",
    worktreePath: `/tmp/worktrees/${fixture.id}`,
  } as unknown as Worktree;
}

function getTrackedState(ports: TeamRunDeletionPorts) {
  return (ports as unknown as { _deleted: { tasks: string[]; artifactsByTask: string[]; worktrees: string[]; notes: string[]; backgroundTasks: string[] } })._deleted;
}

function getActiveSet(ports: TeamRunDeletionPorts) {
  return (ports as unknown as { _active: Set<string> })._active;
}

function expectNoMutations(ports: TeamRunDeletionPorts, events: string[]) {
  const deleted = getTrackedState(ports);
  expect(deleted.tasks).toEqual([]);
  expect(deleted.artifactsByTask).toEqual([]);
  expect(deleted.worktrees).toEqual([]);
  expect(deleted.notes).toEqual([]);
  expect(deleted.backgroundTasks).toEqual([]);
  expect(events.filter((event) => event.startsWith("clear-in-memory:"))).toEqual([]);
  expect(events.filter((event) => event.startsWith("worktree-fs:"))).toEqual([]);
  expect(events.filter((event) => event.startsWith("local-file:"))).toEqual([]);
  expect(events.filter((event) => event.startsWith("kanban-event:"))).toEqual([]);
}

beforeEach(() => {
  driverRef.current = "memory";
  sqliteState.transactionCalls = 0;
  sqliteState.deletedTables = [];
  pgState.batchCalls = 0;
  pgState.batchedStatements = 0;
  pgState.transactionCalls = 0;
  pgState.deletedTables = [];
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Scenario: empty team ────────────────────────────────────────────────

describe("deleteTeamRun", () => {
  it("deletes an empty team (root only) without touching any store", async () => {
    const events: string[] = [];
    const ports = createPorts({ sessions: [teamSession("root-1")] }, events);

    const result = await deleteTeamRun(ports, "root-1");

    expect(result.deleted).toEqual({
      agentsStopped: 0,
      sessions: 1,
      kanbanCards: 0,
      artifacts: 0,
      worktrees: 0,
      notes: 0,
      backgroundTasks: 0,
    });
    expect(result.preserved).toEqual({ sharedKanbanCards: 0, sharedWorktrees: 0 });
    expect(result.warnings).toEqual([]);
    expect(getTrackedState(ports).tasks).toEqual([]);
    expect(events).toEqual([
      "clear-in-memory:root-1",
      "local-file:root-1",
    ]);
  });

  // ─── Scenario: multi-level children ──────────────────────────────────

  it("recursively deletes multi-level descendant sessions", async () => {
    const events: string[] = [];
    const ports = createPorts({ sessions: defaultTeamSessions() }, events);

    const result = await deleteTeamRun(ports, "root-1");

    expect(result.deleted.sessions).toBe(3);
    const cleared = events.filter((event) => event.startsWith("clear-in-memory:"));
    expect(cleared).toEqual([
      "clear-in-memory:root-1",
      "clear-in-memory:child-1",
      "clear-in-memory:grandchild-1",
    ]);
    // Sessions outside the tree are untouched.
    expect(cleared).not.toContain("clear-in-memory:outsider-1");
  });

  // ─── Scenario: active team stops agents first ────────────────────────

  it("stops active agents before deleting any data", async () => {
    const events: string[] = [];
    const ports = createPorts(
      {
        sessions: defaultTeamSessions(),
        activeSessionIds: ["root-1", "child-1"],
        tasks: [taskFixture({ id: "task-1", triggerSessionId: "root-1" })],
      },
      events,
    );

    const result = await deleteTeamRun(ports, "root-1");

    expect(result.deleted.agentsStopped).toBe(2);
    expect(events[0]).toBe("kill:root-1");
    expect(events[1]).toBe("kill:child-1");

    const firstStoreIndex = events.findIndex((event) => event.startsWith("store:"));
    const lastKillIndex = Math.max(
      events.indexOf("kill:root-1"),
      events.indexOf("kill:child-1"),
    );
    expect(firstStoreIndex).toBeGreaterThan(lastKillIndex);
    expect(getActiveSet(ports).size).toBe(0);
    expect(result.deleted.kanbanCards).toBe(1);
  });

  // ─── Scenario: failure leaves no half-deleted state ──────────────────

  it("refuses deletion and mutates nothing when agents cannot be stopped", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const ports = createPorts(
      {
        sessions: defaultTeamSessions(),
        activeSessionIds: ["root-1"],
        tasks: [taskFixture({ id: "task-1", triggerSessionId: "root-1" })],
      },
      events,
    );
    // Overwrite kill to always fail.
    (ports as unknown as { killSessionProcess: (id: string) => Promise<void> }).killSessionProcess =
      async () => {
        events.push("kill-failed:root-1");
        throw new Error("process refuses to die");
      };

    try {
      const promise = deleteTeamRun(ports, "root-1");
      const assertion = expect(promise).rejects.toMatchObject({
        code: "TEAM_RUN_STOP_FAILED",
        details: { failedSessionIds: ["root-1"] },
      });
      await vi.advanceTimersByTimeAsync(6_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    expectNoMutations(ports, events);
  });

  it("refuses deletion when a killed process is still alive afterwards", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const ports = createPorts(
      { sessions: defaultTeamSessions(), activeSessionIds: ["child-1"] },
      events,
    );
    // Kill "succeeds" but the process never actually exits.
    (ports as unknown as { killSessionProcess: (id: string) => Promise<void> }).killSessionProcess =
      async (sessionId: string) => {
        events.push(`kill-zombie:${sessionId}`);
      };

    try {
      const promise = deleteTeamRun(ports, "root-1");
      const assertion = expect(promise).rejects.toMatchObject({ code: "TEAM_RUN_STOP_FAILED" });
      await vi.advanceTimersByTimeAsync(6_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    expectNoMutations(ports, events);
  });

  it("refuses deletion when runner-mode sessions are present, before stopping anything", async () => {
    const events: string[] = [];
    const ports = createPorts(
      {
        sessions: [
          teamSession("root-1"),
          teamSession("child-1", { parentSessionId: "root-1", executionMode: "runner" }),
        ],
        activeSessionIds: ["root-1"],
        tasks: [taskFixture({ id: "task-1", triggerSessionId: "root-1" })],
      },
      events,
    );

    await expect(deleteTeamRun(ports, "root-1")).rejects.toMatchObject({
      code: "TEAM_RUN_RUNNER_UNSUPPORTED",
      details: { runnerSessionIds: ["child-1"] },
    });

    expectNoMutations(ports, events);
    expect(events.filter((event) => event.startsWith("kill:"))).toEqual([]);
  });

  // ─── Scenario: only team-linked cards deleted ────────────────────────

  it("deletes only kanban cards owned by the team tree", async () => {
    const events: string[] = [];
    const ports = createPorts(
      {
        sessions: defaultTeamSessions(),
        tasks: [
          // Owned via triggerSessionId → deleted.
          taskFixture({ id: "task-owned-trigger", triggerSessionId: "root-1" }),
          // Owned via laneSessions → deleted.
          taskFixture({
            id: "task-owned-lane",
            laneSessions: [{ sessionId: "child-1" }],
          }),
          // References the tree AND a live outside session → preserved.
          taskFixture({
            id: "task-shared",
            sessionIds: ["root-1", "outsider-1"],
          }),
          // Unrelated to the tree → untouched.
          taskFixture({ id: "task-unrelated", sessionId: "outsider-1" }),
          // References the tree plus a session that no longer exists → deleted
          // (dead refs do not make a card shared).
          taskFixture({
            id: "task-dead-ref",
            sessionIds: ["grandchild-1", "ghost-session"],
          }),
        ],
        artifactsByTask: {
          "task-owned-trigger": ["artifact-1", "artifact-2"],
          "task-owned-lane": ["artifact-3"],
          "task-shared": ["artifact-shared"],
          "task-unrelated": ["artifact-unrelated"],
        },
      },
      events,
    );

    const result = await deleteTeamRun(ports, "root-1");
    const deleted = getTrackedState(ports);

    expect(new Set(deleted.tasks)).toEqual(
      new Set(["task-owned-trigger", "task-owned-lane", "task-dead-ref"]),
    );
    expect(deleted.artifactsByTask).toEqual(
      expect.arrayContaining(["task-owned-trigger", "task-owned-lane", "task-dead-ref"]),
    );
    expect(result.deleted.kanbanCards).toBe(3);
    expect(result.deleted.artifacts).toBe(3);
    expect(result.preserved.sharedKanbanCards).toBe(1);
    expect(deleted.tasks).not.toContain("task-shared");
    expect(deleted.tasks).not.toContain("task-unrelated");

    // Artifacts of preserved / unrelated cards are never touched.
    expect(deleted.artifactsByTask).not.toContain("task-shared");
    expect(deleted.artifactsByTask).not.toContain("task-unrelated");

    // Kanban SSE notifications fire for every deleted card.
    expect(new Set(events.filter((event) => event.startsWith("kanban-event:")))).toEqual(
      new Set(["kanban-event:task-owned-trigger", "kanban-event:task-owned-lane", "kanban-event:task-dead-ref"]),
    );
  });

  // ─── Scenario: shared artifact/worktree preserved ────────────────────

  it("preserves worktrees still referenced by surviving tasks or sessions", async () => {
    const events: string[] = [];
    const ports = createPorts(
      {
        sessions: defaultTeamSessions(),
        tasks: [
          taskFixture({
            id: "task-owned",
            triggerSessionId: "root-1",
            worktreeId: "wt-exclusive-task",
            laneSessions: [{ sessionId: "child-1", worktreeId: "wt-shared-task" }],
          }),
          // Surviving task keeps a reference to wt-shared-task.
          taskFixture({
            id: "task-survivor",
            sessionId: "outsider-1",
            worktreeId: "wt-shared-task",
          }),
        ],
        worktrees: [
          // Referenced only by the deleted task → deleted.
          worktreeFixture({ id: "wt-exclusive-task" }),
          // Referenced by both the deleted task and a surviving task → preserved.
          worktreeFixture({ id: "wt-shared-task" }),
          // Carries a team tree session ID → deleted.
          worktreeFixture({ id: "wt-tree-session", sessionId: "grandchild-1" }),
          // Carries an outside session ID → preserved.
          worktreeFixture({ id: "wt-outside-session", sessionId: "outsider-1" }),
          // No team linkage at all → untouched.
          worktreeFixture({ id: "wt-unrelated" }),
        ],
      },
      events,
    );

    const result = await deleteTeamRun(ports, "root-1");
    const deleted = getTrackedState(ports);

    expect(new Set(deleted.worktrees)).toEqual(new Set(["wt-exclusive-task", "wt-tree-session"]));
    expect(result.deleted.worktrees).toBe(2);
    // wt-shared-task is team-linked but shared with a survivor → preserved and
    // counted. wt-outside-session / wt-unrelated are not team-linked at all,
    // so they are simply never touched.
    expect(result.preserved.sharedWorktrees).toBe(1);
    expect(deleted.worktrees).not.toContain("wt-shared-task");
    expect(deleted.worktrees).not.toContain("wt-outside-session");
    expect(deleted.worktrees).not.toContain("wt-unrelated");

    // Filesystem cleanup happens for deleted worktrees only, after the DB work.
    expect(new Set(events.filter((event) => event.startsWith("worktree-fs:")))).toEqual(
      new Set(["worktree-fs:wt-exclusive-task", "worktree-fs:wt-tree-session"]),
    );
    const firstStoreIndex = events.findIndex((event) => event.startsWith("store:"));
    const firstFsIndex = events.findIndex((event) => event.startsWith("worktree-fs:"));
    expect(firstFsIndex).toBeGreaterThan(firstStoreIndex);
  });

  it("deletes notes linked to team sessions (and their reply chains) but not workspace notes", async () => {
    const ports = createPorts({
      sessions: defaultTeamSessions(),
      notes: [
        { id: "note-root", sessionId: "root-1" },
        { id: "note-child", sessionId: "child-1" },
        // Reply to a deleted note, no session of its own → deleted.
        { id: "note-reply", metadata: { parentNoteId: "note-root" } },
        // Reply linked to a surviving session → preserved.
        { id: "note-reply-survivor", sessionId: "outsider-1", metadata: { parentNoteId: "note-root" } },
        // Workspace-level spec note (no session) → preserved.
        { id: "note-workspace" },
        // Note of an outside session → preserved.
        { id: "note-outside", sessionId: "outsider-1" },
      ],
      backgroundTasks: [
        { id: "bg-team", resultSessionId: "grandchild-1" },
        { id: "bg-other", resultSessionId: "outsider-1" },
        { id: "bg-none" },
      ],
    });

    const result = await deleteTeamRun(ports, "root-1");
    const deleted = getTrackedState(ports);

    expect(new Set(deleted.notes)).toEqual(new Set(["note-root", "note-child", "note-reply"]));
    expect(result.deleted.notes).toBe(3);
    expect(new Set(deleted.backgroundTasks)).toEqual(new Set(["bg-team"]));
    expect(result.deleted.backgroundTasks).toBe(1);
  });

  it("records warnings when best-effort filesystem cleanup fails", async () => {
    const ports = createPorts({
      sessions: [teamSession("root-1")],
      worktrees: [worktreeFixture({ id: "wt-1", sessionId: "root-1" })],
    });
    (ports as unknown as {
      removeWorktreeDirectory: (worktree: Worktree) => Promise<void>;
      deleteLocalSessionFile: (cwd: string, id: string) => Promise<void>;
    }).removeWorktreeDirectory = async () => {
      throw new Error("permission denied");
    };
    (ports as unknown as {
      deleteLocalSessionFile: (cwd: string, id: string) => Promise<void>;
    }).deleteLocalSessionFile = async () => {
      throw new Error("file locked");
    };

    const result = await deleteTeamRun(ports, "root-1");

    expect(result.warnings).toEqual([
      "worktree-directory-cleanup-failed:wt-1",
      "local-session-file-cleanup-failed:root-1",
    ]);
    expect(result.deleted.worktrees).toBe(1);
  });

  // ─── Validation errors ───────────────────────────────────────────────

  it("rejects unknown sessions, non-team-root sessions and cross-workspace requests", async () => {
    const events: string[] = [];
    const sessions = defaultTeamSessions();
    const ports = createPorts(
      { sessions, tasks: [taskFixture({ id: "task-1", triggerSessionId: "root-1" })] },
      events,
    );

    await expect(deleteTeamRun(ports, "missing")).rejects.toMatchObject({
      code: "TEAM_RUN_NOT_FOUND",
    });
    await expect(deleteTeamRun(ports, "child-1")).rejects.toMatchObject({
      code: "TEAM_RUN_NOT_TEAM_ROOT",
    });
    await expect(deleteTeamRun(ports, "outsider-1")).rejects.toMatchObject({
      code: "TEAM_RUN_NOT_TEAM_ROOT",
    });
    await expect(deleteTeamRun(ports, "root-1", "other-workspace")).rejects.toMatchObject({
      code: "TEAM_RUN_WORKSPACE_MISMATCH",
    });

    // Every rejection happens before any mutation.
    expectNoMutations(ports, events);
  });

  it("throws TeamRunDeletionError instances with stable codes", async () => {
    const ports = createPorts({ sessions: [] });
    const error = await deleteTeamRun(ports, "nope").catch((value) => value);
    expect(error).toBeInstanceOf(TeamRunDeletionError);
    expect(error).toBeInstanceOf(Error);
  });

  // ─── Preview plan ────────────────────────────────────────────────────

  it("builds a preview plan without mutating anything", async () => {
    const events: string[] = [];
    const ports = createPorts(
      {
        sessions: defaultTeamSessions(),
        activeSessionIds: ["root-1"],
        tasks: [
          taskFixture({ id: "task-owned", triggerSessionId: "root-1", worktreeId: "wt-1" }),
          taskFixture({ id: "task-shared", sessionIds: ["root-1", "outsider-1"] }),
        ],
        artifactsByTask: { "task-owned": ["artifact-1"] },
        worktrees: [worktreeFixture({ id: "wt-1" })],
        notes: [{ id: "note-root", sessionId: "root-1" }],
        backgroundTasks: [{ id: "bg-1", resultSessionId: "child-1" }],
      },
      events,
    );

    const plan = await buildTeamRunDeletionPlan(ports, "root-1", "ws-1");

    expect(plan.rootSessionId).toBe("root-1");
    expect(plan.teamName).toBe("Team - Alpha");
    expect(plan.workspaceId).toBe("ws-1");
    expect(plan.sessionIds).toEqual(["root-1", "child-1", "grandchild-1"]);
    expect(plan.activeSessionIds).toEqual(["root-1"]);
    expect(plan.runnerSessionIds).toEqual([]);
    expect(plan.kanbanTaskIds).toEqual(["task-owned"]);
    expect(plan.sharedKanbanTaskIds).toEqual(["task-shared"]);
    expect(plan.artifactIds).toEqual(["artifact-1"]);
    expect(plan.worktrees.map((worktree) => worktree.id)).toEqual(["wt-1"]);
    expect(plan.sharedWorktreeIds).toEqual([]);
    expect(plan.noteIds).toEqual(["note-root"]);
    expect(plan.backgroundTaskIds).toEqual(["bg-1"]);
    expect(events).toEqual([]);
  });

  // ─── Persistent drivers ──────────────────────────────────────────────

  it("routes sqlite deletions through a single synchronous transaction", async () => {
    driverRef.current = "sqlite";
    const ports = createPorts({
      sessions: defaultTeamSessions(),
      tasks: [taskFixture({ id: "task-1", triggerSessionId: "root-1", worktreeId: "wt-1" })],
      worktrees: [worktreeFixture({ id: "wt-1" })],
      notes: [{ id: "note-1", sessionId: "root-1" }],
      backgroundTasks: [{ id: "bg-1", resultSessionId: "child-1" }],
    });

    const result = await deleteTeamRun(ports, "root-1");

    expect(sqliteState.transactionCalls).toBe(1);
    expect(new Set(sqliteState.deletedTables)).toEqual(
      new Set([
        "sqlite.artifactRequests",
        "sqlite.artifacts",
        "sqlite.tasks",
        "sqlite.backgroundTasks",
        "sqlite.notes",
        "sqlite.worktrees",
        "sqlite.sessionMessages",
        "sqlite.acpSessions",
      ]),
    );
    expect(result.deleted.sessions).toBe(3);
    expect(result.deleted.kanbanCards).toBe(1);
    // With a persistent driver the in-memory stores are not used for deletes.
    expect(getTrackedState(ports).tasks).toEqual([]);
  });

  it("skips empty statement groups in the sqlite transaction", async () => {
    driverRef.current = "sqlite";
    const ports = createPorts({ sessions: [teamSession("root-1")] });

    const result = await deleteTeamRun(ports, "root-1");

    expect(sqliteState.transactionCalls).toBe(1);
    // No tasks/notes/worktrees/background tasks → only session tables deleted.
    expect(new Set(sqliteState.deletedTables)).toEqual(
      new Set(["sqlite.sessionMessages", "sqlite.acpSessions"]),
    );
    expect(result.deleted.sessions).toBe(1);
  });

  it("sends neon-http deletions as one atomic batch", async () => {
    driverRef.current = "postgres";
    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://user@ep-abc.eu-central-1.aws.neon.tech/routa";
    try {
      const ports = createPorts({
        sessions: defaultTeamSessions(),
        tasks: [taskFixture({ id: "task-1", triggerSessionId: "root-1", worktreeId: "wt-1" })],
        worktrees: [worktreeFixture({ id: "wt-1" })],
        notes: [{ id: "note-1", sessionId: "root-1" }],
        backgroundTasks: [{ id: "bg-1", resultSessionId: "child-1" }],
      });

      const result = await deleteTeamRun(ports, "root-1");

      expect(pgState.batchCalls).toBe(1);
      expect(pgState.transactionCalls).toBe(0);
      // artifactRequests, artifacts, tasks, backgroundTasks, notes, worktrees,
      // traces, sessionMessages, acpSessions
      expect(pgState.batchedStatements).toBe(9);
      expect(new Set(pgState.deletedTables)).toEqual(
        new Set([
          pgSchema.artifactRequests,
          pgSchema.artifacts,
          pgSchema.tasks,
          pgSchema.backgroundTasks,
          pgSchema.notes,
          pgSchema.worktrees,
          pgSchema.traces,
          pgSchema.sessionMessages,
          pgSchema.acpSessions,
        ]),
      );
      expect(result.deleted.sessions).toBe(3);
    } finally {
      process.env.DATABASE_URL = previousUrl;
    }
  });

  it("wraps postgres-js deletions in an interactive transaction", async () => {
    driverRef.current = "postgres";
    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://localhost:5432/routa";
    try {
      const ports = createPorts({
        sessions: defaultTeamSessions(),
        tasks: [taskFixture({ id: "task-1", triggerSessionId: "root-1" })],
      });

      const result = await deleteTeamRun(ports, "root-1");

      expect(pgState.transactionCalls).toBe(1);
      expect(pgState.batchCalls).toBe(0);
      expect(new Set(pgState.deletedTables)).toEqual(
        new Set([
          pgSchema.artifactRequests,
          pgSchema.artifacts,
          pgSchema.tasks,
          pgSchema.traces,
          pgSchema.sessionMessages,
          pgSchema.acpSessions,
        ]),
      );
      expect(result.deleted.kanbanCards).toBe(1);
    } finally {
      process.env.DATABASE_URL = previousUrl;
    }
  });
});
