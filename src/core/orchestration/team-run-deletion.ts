/**
 * Team Run deletion service.
 *
 * Deletes a Team Run — the top-level Team Lead session and its whole
 * descendant session tree — together with the data that belongs exclusively
 * to that tree: kanban cards, artifacts, worktrees, notes and background
 * tasks. Anything shared with sessions/tasks outside the tree is preserved.
 *
 * Safety boundaries (all enforced server-side):
 * - Only sessions identified as Team Run roots can be deleted.
 * - Active agent processes are stopped and verified to be gone before any
 *   data is deleted.
 * - Runner-mode sessions cannot be stopped locally, so their presence aborts
 *   the deletion before any mutation.
 * - Persistent data is removed in a single database transaction
 *   (Postgres/SQLite); the in-memory driver falls back to store calls.
 * - Worktree branches and the main repository are never touched; worktree
 *   directories are only removed from the filesystem as best-effort cleanup
 *   after the DB row is gone.
 * - Workspaces, codebases, kanban boards and other teams are never touched.
 */

import { and, eq, inArray } from "drizzle-orm";
import { getDatabaseDriver, getPostgresDatabase } from "@/core/db/index";
import * as pgSchema from "@/core/db/schema";
import type { RoutaSystem } from "@/core/routa-system";
import type { Task } from "@/core/models/task";
import type { Worktree } from "@/core/models/worktree";
import {
  collectTeamSessionIds,
  isTeamRunRoot,
  type TeamRunSessionShape,
} from "./team-run-identity";

// ─── Errors ──────────────────────────────────────────────────────────────

export type TeamRunDeletionErrorCode =
  | "TEAM_RUN_NOT_FOUND"
  | "TEAM_RUN_NOT_TEAM_ROOT"
  | "TEAM_RUN_WORKSPACE_MISMATCH"
  | "TEAM_RUN_RUNNER_UNSUPPORTED"
  | "TEAM_RUN_STOP_FAILED";

export class TeamRunDeletionError extends Error {
  constructor(
    public readonly code: TeamRunDeletionErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TeamRunDeletionError";
  }
}

// ─── Ports ───────────────────────────────────────────────────────────────

/** Session shape needed by the deletion service. */
export interface TeamRunSessionRecord extends TeamRunSessionShape {
  cwd: string;
  workspaceId: string;
  routaAgentId?: string;
  executionMode?: string;
}

export interface TeamRunDeletionPorts {
  /** All ACP sessions known to this server (in-memory store, DB-hydrated). */
  listSessions(): Promise<TeamRunSessionRecord[]> | TeamRunSessionRecord[];
  /** Whether an agent process is currently alive for the session. */
  hasActiveProcess(sessionId: string): boolean;
  /** Kill the session's agent process/adapter. */
  killSessionProcess(sessionId: string): Promise<void>;
  /** Domain stores used for ownership checks and in-memory driver deletes. */
  system: Pick<
    RoutaSystem,
    | "agentStore"
    | "conversationStore"
    | "eventBus"
    | "taskStore"
    | "artifactStore"
    | "worktreeStore"
    | "noteStore"
    | "backgroundTaskStore"
  >;
  /** Remove a session from the in-memory HTTP store (buffers, SSE, activity). */
  clearInMemorySession(sessionId: string): void;
  /** Best-effort removal of the local JSONL session file. */
  deleteLocalSessionFile?(cwd: string, sessionId: string): Promise<void>;
  /** Filesystem-only worktree directory removal (branch + DB untouched). */
  removeWorktreeDirectory?(worktree: Worktree): Promise<void>;
  /** Emit kanban change events so open kanban UIs resync. */
  notifyTaskDeleted?(workspaceId: string, taskId: string): void;
}

// ─── Plan / Result types ─────────────────────────────────────────────────

export interface TeamRunDeletionPlan {
  rootSessionId: string;
  teamName: string;
  workspaceId: string;
  /** All session IDs in the tree, root first. */
  sessionIds: string[];
  /** Sessions with live agent processes that must be stopped first. */
  activeSessionIds: string[];
  /** Sessions running in runner mode — deletion is refused while present. */
  runnerSessionIds: string[];
  /** Agent records owned exclusively by this Team Run. */
  agentIds: string[];
  /** Agent records referenced by an outside session and therefore preserved. */
  sharedAgentIds: string[];
  /** Kanban cards owned exclusively by this team; will be deleted. */
  kanbanTaskIds: string[];
  /** Subset of kanbanTaskIds matched by the explicit `teamRunId` ownership. */
  explicitKanbanTaskIds: string[];
  /** Subset of kanbanTaskIds matched only by the legacy session-tree links. */
  legacyKanbanTaskIds: string[];
  /** Legacy cards (no `teamRunId`) linked to the team tree and referenced by
   *  live outside sessions; kept. Explicitly owned cards never land here. */
  sharedKanbanTaskIds: string[];
  /** Artifacts belonging to deleted cards. */
  artifactIds: string[];
  /** Worktrees owned exclusively by this team; DB rows deleted, directories
   *  removed best-effort when inside a Routa-managed worktree root. */
  worktrees: Worktree[];
  /** Worktrees referenced by the team but shared with survivors; kept. */
  sharedWorktreeIds: string[];
  noteIds: string[];
  backgroundTaskIds: string[];
}

export interface TeamRunDeletionResult {
  rootSessionId: string;
  teamName: string;
  workspaceId: string;
  deleted: {
    agentsStopped: number;
    sessions: number;
    kanbanCards: number;
    artifacts: number;
    worktrees: number;
    notes: number;
    backgroundTasks: number;
  };
  preserved: {
    sharedKanbanCards: number;
    sharedWorktrees: number;
  };
  /** Machine-readable warnings, e.g. failed best-effort cleanup steps. */
  warnings: string[];
}

const STOP_SETTLE_TIMEOUT_MS = 5_000;
const STOP_SETTLE_POLL_MS = 50;

// ─── Ownership helpers ───────────────────────────────────────────────────

/** All session IDs referenced by a kanban task through any session-link field. */
export function collectTaskSessionRefs(task: Task): string[] {
  const refs = new Set<string>();
  if (task.sessionId) refs.add(task.sessionId);
  if (task.triggerSessionId) refs.add(task.triggerSessionId);
  for (const id of task.sessionIds ?? []) {
    if (id) refs.add(id);
  }
  for (const lane of task.laneSessions ?? []) {
    if (lane.sessionId) refs.add(lane.sessionId);
  }
  return [...refs];
}

/** Worktree IDs referenced by a task (task-level + per-lane). */
function collectTaskWorktreeRefs(task: Task): string[] {
  const refs = new Set<string>();
  if (task.worktreeId) refs.add(task.worktreeId);
  for (const lane of task.laneSessions ?? []) {
    if (lane.worktreeId) refs.add(lane.worktreeId);
  }
  return [...refs];
}

// ─── Validation + planning ───────────────────────────────────────────────

async function resolveTeamRun(
  ports: TeamRunDeletionPorts,
  rootSessionId: string,
  expectedWorkspaceId?: string,
): Promise<{ sessions: TeamRunSessionRecord[]; root: TeamRunSessionRecord }> {
  const sessions = await ports.listSessions();
  const root = sessions.find((session) => session.sessionId === rootSessionId);
  if (!root) {
    throw new TeamRunDeletionError(
      "TEAM_RUN_NOT_FOUND",
      `Session not found: ${rootSessionId}`,
      { rootSessionId },
    );
  }

  if (!isTeamRunRoot(root, sessions)) {
    throw new TeamRunDeletionError(
      "TEAM_RUN_NOT_TEAM_ROOT",
      `Session ${rootSessionId} is not a Team Run root session`,
      { rootSessionId },
    );
  }

  if (expectedWorkspaceId && root.workspaceId !== expectedWorkspaceId) {
    throw new TeamRunDeletionError(
      "TEAM_RUN_WORKSPACE_MISMATCH",
      `Team Run belongs to workspace ${root.workspaceId}, not ${expectedWorkspaceId}`,
      { rootSessionId, workspaceId: root.workspaceId, expectedWorkspaceId },
    );
  }

  return { sessions, root };
}

async function buildPlanFromSessions(
  ports: TeamRunDeletionPorts,
  sessions: TeamRunSessionRecord[],
  root: TeamRunSessionRecord,
): Promise<TeamRunDeletionPlan> {
  const sessionIds = collectTeamSessionIds(root.sessionId, sessions);
  const treeSet = new Set(sessionIds);
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
  const existingSessionIds = new Set(sessions.map((session) => session.sessionId));

  const activeSessionIds = sessionIds.filter((id) => ports.hasActiveProcess(id));
  const runnerSessionIds = sessionIds.filter(
    (id) => sessionById.get(id)?.executionMode === "runner",
  );

  // Agents are private only when their owning session belongs to this tree
  // and no surviving session references the same routaAgentId. Include child
  // Agent records recursively because the orchestrator creates child agents
  // under the Team Lead even when they do not own an ACP session themselves.
  const treeSessionAgentIds = new Set(
    sessionIds
      .map((id) => sessionById.get(id)?.routaAgentId)
      .filter((id): id is string => Boolean(id)),
  );
  const outsideSessionAgentIds = new Set(
    sessions
      .filter((session) => !treeSet.has(session.sessionId))
      .map((session) => session.routaAgentId)
      .filter((id): id is string => Boolean(id)),
  );
  const workspaceAgents = await ports.system.agentStore.listByWorkspace(root.workspaceId);
  const privateAgentIds = new Set(
    [...treeSessionAgentIds].filter((agentId) => !outsideSessionAgentIds.has(agentId)),
  );
  let agentTreeGrew = true;
  while (agentTreeGrew) {
    agentTreeGrew = false;
    for (const agent of workspaceAgents) {
      if (!agent.parentId || !privateAgentIds.has(agent.parentId) || privateAgentIds.has(agent.id)) continue;
      privateAgentIds.add(agent.id);
      agentTreeGrew = true;
    }
  }
  const workspaceAgentIds = new Set(workspaceAgents.map((agent) => agent.id));
  const agentIds = [...privateAgentIds].filter((agentId) => workspaceAgentIds.has(agentId));
  const sharedAgentIds = [...treeSessionAgentIds].filter((agentId) => outsideSessionAgentIds.has(agentId));

  // Kanban card ownership follows a strict priority:
  //
  // 1. Explicit ownership is authoritative. `task.teamRunId` names the Team
  //    Run that owns the card:
  //    - `teamRunId === root.sessionId` → the card belongs to this team and is
  //      deleted, no matter what its session-link fields say.
  //    - any other non-empty `teamRunId` → the card belongs to another team
  //      and is never touched, even when it references this tree's sessions.
  //    The session-link fields (`sessionId`, `triggerSessionId`, `sessionIds`,
  //    `laneSessions`) only record execution history; they never override
  //    explicit ownership. This matters because kanban lane automation creates
  //    sessions without a Team root `parentSessionId`, so those sessions sit
  //    outside the Team tree even when they execute a Team-owned card.
  // 2. Legacy inference only applies to cards with no `teamRunId` at all
  //    (created before `teamRunId` existed): such a card is deleted when its
  //    session links intersect the tree, unless a live session *outside* the
  //    tree also references it — in which case it is preserved as shared.
  const tasks = await ports.system.taskStore.listByWorkspace(root.workspaceId);
  const kanbanTaskIds: string[] = [];
  const explicitKanbanTaskIds: string[] = [];
  const legacyKanbanTaskIds: string[] = [];
  const sharedKanbanTaskIds: string[] = [];
  for (const task of tasks) {
    if (task.teamRunId) {
      if (task.teamRunId === root.sessionId) {
        kanbanTaskIds.push(task.id);
        explicitKanbanTaskIds.push(task.id);
      }
      continue;
    }

    const refs = collectTaskSessionRefs(task);
    const linkedToDeletedTree = refs.some((id) => treeSet.has(id));
    if (!linkedToDeletedTree) continue;

    const linkedToLiveOutsideSession = refs.some(
      (id) => !treeSet.has(id) && existingSessionIds.has(id),
    );
    if (linkedToLiveOutsideSession) {
      sharedKanbanTaskIds.push(task.id);
      continue;
    }

    kanbanTaskIds.push(task.id);
    legacyKanbanTaskIds.push(task.id);
  }

  // Artifacts belong to exactly one task (artifact.taskId), so deleting the
  // card's artifacts cannot affect other teams.
  const artifactIds: string[] = [];
  for (const taskId of kanbanTaskIds) {
    const artifacts = await ports.system.artifactStore.listByTask(taskId);
    artifactIds.push(...artifacts.map((artifact) => artifact.id));
  }

  // Worktrees: candidates are referenced by deleted tasks or carry a team
  // session ID; survivors' references always win.
  const deletedTaskSet = new Set(kanbanTaskIds);
  const deletedTaskWorktreeRefs = new Set<string>();
  const survivingWorktreeRefs = new Set<string>();
  for (const task of tasks) {
    const target = deletedTaskSet.has(task.id) ? deletedTaskWorktreeRefs : survivingWorktreeRefs;
    for (const worktreeId of collectTaskWorktreeRefs(task)) {
      target.add(worktreeId);
    }
  }

  const workspaceWorktrees = await ports.system.worktreeStore.listByWorkspace(root.workspaceId);
  const worktrees: Worktree[] = [];
  const sharedWorktreeIds: string[] = [];
  for (const worktree of workspaceWorktrees) {
    const ownedByTeam =
      deletedTaskWorktreeRefs.has(worktree.id)
      || (!!worktree.sessionId && treeSet.has(worktree.sessionId));
    if (!ownedByTeam) continue;

    const preserved =
      survivingWorktreeRefs.has(worktree.id)
      || (!!worktree.sessionId && !treeSet.has(worktree.sessionId));
    if (preserved) {
      sharedWorktreeIds.push(worktree.id);
    } else {
      worktrees.push(worktree);
    }
  }

  // Notes: created by a team session; plus notes hanging off deleted notes
  // unless they belong to a surviving session. Workspace-level notes (spec)
  // have no session linkage and are never matched here.
  const workspaceNotes = await ports.system.noteStore.listByWorkspace(root.workspaceId);
  const noteIds: string[] = [];
  const deletedNoteIds = new Set<string>();
  for (const note of workspaceNotes) {
    if (note.sessionId && treeSet.has(note.sessionId)) {
      noteIds.push(note.id);
      deletedNoteIds.add(note.id);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const note of workspaceNotes) {
      if (deletedNoteIds.has(note.id)) continue;
      const parentId = note.metadata?.parentNoteId;
      if (!parentId || !deletedNoteIds.has(parentId)) continue;
      if (note.sessionId && !treeSet.has(note.sessionId)) continue;
      noteIds.push(note.id);
      deletedNoteIds.add(note.id);
      grew = true;
    }
  }

  // Background tasks whose resulting session belongs to the tree.
  const backgroundTasks = await ports.system.backgroundTaskStore.listByWorkspace(root.workspaceId);
  const backgroundTaskIds = backgroundTasks
    .filter((task) => task.resultSessionId && treeSet.has(task.resultSessionId))
    .map((task) => task.id);

  return {
    rootSessionId: root.sessionId,
    teamName: root.name ?? "",
    workspaceId: root.workspaceId,
    sessionIds,
    activeSessionIds,
    runnerSessionIds,
    agentIds,
    sharedAgentIds,
    kanbanTaskIds,
    explicitKanbanTaskIds,
    legacyKanbanTaskIds,
    sharedKanbanTaskIds,
    artifactIds,
    worktrees,
    sharedWorktreeIds,
    noteIds,
    backgroundTaskIds,
  };
}

/**
 * Validate the target and compute everything a deletion would touch.
 * Used by both the preview endpoint and the delete flow itself.
 */
export async function buildTeamRunDeletionPlan(
  ports: TeamRunDeletionPorts,
  rootSessionId: string,
  expectedWorkspaceId?: string,
): Promise<TeamRunDeletionPlan> {
  const { sessions, root } = await resolveTeamRun(ports, rootSessionId, expectedWorkspaceId);
  return buildPlanFromSessions(ports, sessions, root);
}

// ─── Stop phase ──────────────────────────────────────────────────────────

async function waitForProcessesToStop(
  ports: TeamRunDeletionPorts,
  sessionIds: string[],
): Promise<void> {
  if (sessionIds.length === 0) return;
  const deadline = Date.now() + STOP_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!sessionIds.some((id) => ports.hasActiveProcess(id))) return;
    await new Promise((resolve) => setTimeout(resolve, STOP_SETTLE_POLL_MS));
  }
}

// ─── Persistent deletion ─────────────────────────────────────────────────

async function deleteTeamRunDataPersistent(plan: TeamRunDeletionPlan): Promise<void> {
  const taskIds = plan.kanbanTaskIds;
  const worktreeIds = plan.worktrees.map((worktree) => worktree.id);
  const agentIds = plan.agentIds;

  const driver = getDatabaseDriver();

  if (driver === "postgres") {
    const db = getPostgresDatabase();
    // Mirrors the driver selection in src/core/db/index.ts: Neon endpoints use
    // the neon-http driver, everything else uses postgres-js.
    const databaseUrl = process.env.DATABASE_URL ?? "";
    const isNeon = databaseUrl.includes("neon.tech") || databaseUrl.includes(".neon.database");

    if (isNeon) {
      // neon-http does not support interactive transactions, but batch()
      // sends all statements in one request and Neon executes them as a
      // single atomic transaction.
      const deletes: unknown[] = [];
      if (taskIds.length > 0) {
        deletes.push(db.delete(pgSchema.artifactRequests).where(inArray(pgSchema.artifactRequests.taskId, taskIds)));
        deletes.push(db.delete(pgSchema.artifacts).where(inArray(pgSchema.artifacts.taskId, taskIds)));
        deletes.push(db.delete(pgSchema.tasks).where(inArray(pgSchema.tasks.id, taskIds)));
      }
      if (plan.backgroundTaskIds.length > 0) {
        deletes.push(db.delete(pgSchema.backgroundTasks).where(inArray(pgSchema.backgroundTasks.id, plan.backgroundTaskIds)));
      }
      if (plan.noteIds.length > 0) {
        deletes.push(db.delete(pgSchema.notes).where(
          and(inArray(pgSchema.notes.id, plan.noteIds), eq(pgSchema.notes.workspaceId, plan.workspaceId)),
        ));
      }
      if (worktreeIds.length > 0) {
        deletes.push(db.delete(pgSchema.worktrees).where(inArray(pgSchema.worktrees.id, worktreeIds)));
      }
      if (agentIds.length > 0) {
        deletes.push(db.delete(pgSchema.messages).where(inArray(pgSchema.messages.agentId, agentIds)));
        deletes.push(db.delete(pgSchema.pendingEvents).where(inArray(pgSchema.pendingEvents.agentId, agentIds)));
        deletes.push(db.delete(pgSchema.eventSubscriptions).where(inArray(pgSchema.eventSubscriptions.agentId, agentIds)));
        deletes.push(db.delete(pgSchema.agents).where(inArray(pgSchema.agents.id, agentIds)));
      }
      if (plan.sessionIds.length > 0) {
        deletes.push(db.delete(pgSchema.traces).where(inArray(pgSchema.traces.sessionId, plan.sessionIds)));
        deletes.push(db.delete(pgSchema.sessionMessages).where(inArray(pgSchema.sessionMessages.sessionId, plan.sessionIds)));
        deletes.push(db.delete(pgSchema.acpSessions).where(inArray(pgSchema.acpSessions.id, plan.sessionIds)));
      }
      if (deletes.length > 0) {
        await db.batch(deletes as unknown as Parameters<typeof db.batch>[0]);
      }
      return;
    }

    await db.transaction(async (tx) => {
      if (taskIds.length > 0) {
        await tx.delete(pgSchema.artifactRequests).where(inArray(pgSchema.artifactRequests.taskId, taskIds));
        await tx.delete(pgSchema.artifacts).where(inArray(pgSchema.artifacts.taskId, taskIds));
        await tx.delete(pgSchema.tasks).where(inArray(pgSchema.tasks.id, taskIds));
      }
      if (plan.backgroundTaskIds.length > 0) {
        await tx.delete(pgSchema.backgroundTasks).where(inArray(pgSchema.backgroundTasks.id, plan.backgroundTaskIds));
      }
      if (plan.noteIds.length > 0) {
        await tx.delete(pgSchema.notes).where(
          and(inArray(pgSchema.notes.id, plan.noteIds), eq(pgSchema.notes.workspaceId, plan.workspaceId)),
        );
      }
      if (worktreeIds.length > 0) {
        await tx.delete(pgSchema.worktrees).where(inArray(pgSchema.worktrees.id, worktreeIds));
      }
      if (agentIds.length > 0) {
        await tx.delete(pgSchema.messages).where(inArray(pgSchema.messages.agentId, agentIds));
        await tx.delete(pgSchema.pendingEvents).where(inArray(pgSchema.pendingEvents.agentId, agentIds));
        await tx.delete(pgSchema.eventSubscriptions).where(inArray(pgSchema.eventSubscriptions.agentId, agentIds));
        await tx.delete(pgSchema.agents).where(inArray(pgSchema.agents.id, agentIds));
      }
      if (plan.sessionIds.length > 0) {
        await tx.delete(pgSchema.traces).where(inArray(pgSchema.traces.sessionId, plan.sessionIds));
        await tx.delete(pgSchema.sessionMessages).where(inArray(pgSchema.sessionMessages.sessionId, plan.sessionIds));
        await tx.delete(pgSchema.acpSessions).where(inArray(pgSchema.acpSessions.id, plan.sessionIds));
      }
    });
    return;
  }

  if (driver === "sqlite") {
    // Loaded dynamically so better-sqlite3 never lands in web bundles.
    const { getSqliteDatabase } = await import("@/core/db/sqlite");
    const sqliteSchema = await import("@/core/db/sqlite-schema");
    const db = getSqliteDatabase();

    // better-sqlite3 is synchronous — keep the callback synchronous so the
    // transaction wraps every delete.
    db.transaction((tx) => {
      if (taskIds.length > 0) {
        tx.delete(sqliteSchema.artifactRequests).where(inArray(sqliteSchema.artifactRequests.taskId, taskIds)).run();
        tx.delete(sqliteSchema.artifacts).where(inArray(sqliteSchema.artifacts.taskId, taskIds)).run();
        tx.delete(sqliteSchema.tasks).where(inArray(sqliteSchema.tasks.id, taskIds)).run();
      }
      if (plan.backgroundTaskIds.length > 0) {
        tx.delete(sqliteSchema.backgroundTasks).where(inArray(sqliteSchema.backgroundTasks.id, plan.backgroundTaskIds)).run();
      }
      if (plan.noteIds.length > 0) {
        tx.delete(sqliteSchema.notes).where(
          and(inArray(sqliteSchema.notes.id, plan.noteIds), eq(sqliteSchema.notes.workspaceId, plan.workspaceId)),
        ).run();
      }
      if (worktreeIds.length > 0) {
        tx.delete(sqliteSchema.worktrees).where(inArray(sqliteSchema.worktrees.id, worktreeIds)).run();
      }
      if (agentIds.length > 0) {
        tx.delete(sqliteSchema.messages).where(inArray(sqliteSchema.messages.agentId, agentIds)).run();
        tx.delete(sqliteSchema.pendingEvents).where(inArray(sqliteSchema.pendingEvents.agentId, agentIds)).run();
        tx.delete(sqliteSchema.eventSubscriptions).where(inArray(sqliteSchema.eventSubscriptions.agentId, agentIds)).run();
        tx.delete(sqliteSchema.agents).where(inArray(sqliteSchema.agents.id, agentIds)).run();
      }
      if (plan.sessionIds.length > 0) {
        tx.delete(sqliteSchema.sessionMessages).where(inArray(sqliteSchema.sessionMessages.sessionId, plan.sessionIds)).run();
        tx.delete(sqliteSchema.acpSessions).where(inArray(sqliteSchema.acpSessions.id, plan.sessionIds)).run();
      }
    });
    return;
  }

  // Memory driver — no persistent storage exists; nothing to do here.
}

async function deleteTeamRunDataInMemory(
  ports: TeamRunDeletionPorts,
  plan: TeamRunDeletionPlan,
): Promise<void> {
  const {
    agentStore,
    conversationStore,
    eventBus,
    taskStore,
    artifactStore,
    worktreeStore,
    noteStore,
    backgroundTaskStore,
  } = ports.system;

  for (const agentId of plan.agentIds) {
    await conversationStore.deleteConversation(agentId);
    eventBus.removeAgentData(agentId);
    await agentStore.delete(agentId);
  }

  for (const taskId of plan.kanbanTaskIds) {
    await artifactStore.deleteByTask(taskId);
    await taskStore.delete(taskId);
  }
  for (const taskId of plan.backgroundTaskIds) {
    await backgroundTaskStore.delete(taskId);
  }
  for (const noteId of plan.noteIds) {
    await noteStore.delete(noteId, plan.workspaceId);
  }
  for (const worktree of plan.worktrees) {
    await worktreeStore.remove(worktree.id);
  }
}

// ─── Main delete flow ────────────────────────────────────────────────────

/**
 * Delete a Team Run: stop active agents, verify they are gone, then remove
 * the session tree and all team-exclusive data.
 *
 * Throws TeamRunDeletionError with a stable code when the target is not
 * found, not a Team Run root, cross-workspace, contains runner sessions, or
 * its agents cannot be stopped. In every error case no data is deleted.
 */
export async function deleteTeamRun(
  ports: TeamRunDeletionPorts,
  rootSessionId: string,
  expectedWorkspaceId?: string,
): Promise<TeamRunDeletionResult> {
  const { sessions, root } = await resolveTeamRun(ports, rootSessionId, expectedWorkspaceId);
  const plan = await buildPlanFromSessions(ports, sessions, root);

  // Runner sessions execute on a remote runner host — we cannot stop them
  // locally, so refuse before mutating anything.
  if (plan.runnerSessionIds.length > 0) {
    throw new TeamRunDeletionError(
      "TEAM_RUN_RUNNER_UNSUPPORTED",
      `Team Run contains runner-mode sessions that cannot be stopped locally: ${plan.runnerSessionIds.join(", ")}`,
      { runnerSessionIds: plan.runnerSessionIds },
    );
  }

  // 1. Stop all active agent processes in the tree, then wait for cleanup.
  const killFailures: string[] = [];
  for (const sessionId of plan.activeSessionIds) {
    try {
      await ports.killSessionProcess(sessionId);
    } catch {
      killFailures.push(sessionId);
    }
  }
  await waitForProcessesToStop(ports, plan.activeSessionIds);

  const stillActive = plan.activeSessionIds.filter((id) => ports.hasActiveProcess(id));
  if (killFailures.length > 0 || stillActive.length > 0) {
    throw new TeamRunDeletionError(
      "TEAM_RUN_STOP_FAILED",
      "Failed to stop all active agent processes; nothing was deleted",
      { failedSessionIds: [...new Set([...killFailures, ...stillActive])] },
    );
  }

  // 2. Delete persistent data atomically (single transaction per driver).
  const driver = getDatabaseDriver();
  if (driver === "memory") {
    await deleteTeamRunDataInMemory(ports, plan);
  } else {
    await deleteTeamRunDataPersistent(plan);
  }

  // 3. Drop in-memory session state (all drivers).
  for (const sessionId of plan.sessionIds) {
    ports.clearInMemorySession(sessionId);
  }

  const warnings: string[] = [];

  // 4. Best-effort filesystem cleanup of team-exclusive worktree directories.
  //    Branches and the main repository are never touched.
  for (const worktree of plan.worktrees) {
    if (!ports.removeWorktreeDirectory) continue;
    try {
      await ports.removeWorktreeDirectory(worktree);
    } catch {
      warnings.push(`worktree-directory-cleanup-failed:${worktree.id}`);
    }
  }

  // 5. Best-effort removal of local JSONL session files.
  for (const sessionId of plan.sessionIds) {
    if (!ports.deleteLocalSessionFile) continue;
    const cwd = sessions.find((session) => session.sessionId === sessionId)?.cwd;
    if (!cwd) continue;
    try {
      await ports.deleteLocalSessionFile(cwd, sessionId);
    } catch {
      warnings.push(`local-session-file-cleanup-failed:${sessionId}`);
    }
  }

  // 6. Notify kanban subscribers so open boards drop the deleted cards.
  for (const taskId of plan.kanbanTaskIds) {
    ports.notifyTaskDeleted?.(plan.workspaceId, taskId);
  }

  return {
    rootSessionId: plan.rootSessionId,
    teamName: plan.teamName,
    workspaceId: plan.workspaceId,
    deleted: {
      agentsStopped: plan.activeSessionIds.length,
      sessions: plan.sessionIds.length,
      kanbanCards: plan.kanbanTaskIds.length,
      artifacts: plan.artifactIds.length,
      worktrees: plan.worktrees.length,
      notes: plan.noteIds.length,
      backgroundTasks: plan.backgroundTaskIds.length,
    },
    preserved: {
      sharedKanbanCards: plan.sharedKanbanTaskIds.length,
      sharedWorktrees: plan.sharedWorktreeIds.length,
    },
    warnings,
  };
}
