/**
 * Unassigned historical kanban card management.
 *
 * "Unassigned historical cards" are workspace cards that carry no explicit
 * `teamRunId` ownership and are not linked (through any session-link field)
 * to a Team Run session tree that still exists. They are typically leftovers
 * from before explicit Team Run card ownership existed.
 *
 * Rules (all enforced server-side):
 * - Old cards are never auto-backfilled with a `teamRunId` — ambiguous
 *   ownership must stay unassigned. This service only surfaces the cards and
 *   offers an explicit, confirmation-gated cleanup.
 * - The cleanup deletes the card records only. Codebases, repositories,
 *   worktree branches/directories, artifacts, notes and sessions are never
 *   touched.
 * - A card whose session links intersect any existing Team Run tree is kept
 *   even without explicit ownership, because the link keeps its ownership
 *   ambiguous.
 */

import { and, eq, inArray } from "drizzle-orm";
import { getDatabaseDriver, getPostgresDatabase } from "@/core/db/index";
import * as pgSchema from "@/core/db/schema";
import type { Task } from "@/core/models/task";
import type { TaskStore } from "@/core/store/task-store";
import {
  collectTeamSessionIds,
  isTeamRunRoot,
  type TeamRunSessionShape,
} from "./team-run-identity";
import { collectTaskSessionRefs } from "./team-run-deletion";

/** Session shape needed to detect unassigned cards. */
export interface UnassignedCardsSessionShape extends TeamRunSessionShape {
  workspaceId: string;
}

export interface UnassignedCardsPorts {
  /** All ACP sessions known to this server (in-memory store, DB-hydrated). */
  listSessions():
    | Promise<UnassignedCardsSessionShape[]>
    | UnassignedCardsSessionShape[];
  taskStore: Pick<TaskStore, "listByWorkspace" | "delete">;
  /** Emit kanban change events so open kanban UIs resync. */
  notifyTaskDeleted?(workspaceId: string, taskId: string): void;
}

export interface UnassignedHistoricalCardsPreview {
  workspaceId: string;
  /** Cards with no teamRunId and no link into any existing Team Run tree. */
  taskIds: string[];
}

export interface UnassignedHistoricalCardsDeletionResult {
  workspaceId: string;
  deletedTaskIds: string[];
}

/**
 * All session IDs that belong to a Team Run tree (root + descendants) whose
 * root currently exists in the workspace. Any card linked into one of these
 * trees has ambiguous ownership and must be preserved.
 */
export function collectTeamTreeSessionIds(
  sessions: UnassignedCardsSessionShape[],
  workspaceId: string,
): Set<string> {
  const workspaceSessions = sessions.filter(
    (session) => session.workspaceId === workspaceId,
  );
  const covered = new Set<string>();
  for (const session of workspaceSessions) {
    if (covered.has(session.sessionId)) continue;
    if (!isTeamRunRoot(session, workspaceSessions)) continue;
    for (const id of collectTeamSessionIds(session.sessionId, workspaceSessions)) {
      covered.add(id);
    }
  }
  return covered;
}

/**
 * Cards that are truly unassigned: no explicit `teamRunId` and no session
 * link into an existing Team Run tree. Cards owned by any team (explicitly)
 * or ambiguously linked to a live tree are excluded.
 */
export function findUnassignedHistoricalCardIds(
  tasks: Task[],
  teamTreeSessionIds: Set<string>,
): string[] {
  const ids: string[] = [];
  for (const task of tasks) {
    if (task.teamRunId) continue;
    const refs = collectTaskSessionRefs(task);
    if (refs.some((id) => teamTreeSessionIds.has(id))) continue;
    ids.push(task.id);
  }
  return ids;
}

async function resolveUnassignedTaskIds(
  ports: UnassignedCardsPorts,
  workspaceId: string,
): Promise<string[]> {
  const [sessions, tasks] = await Promise.all([
    ports.listSessions(),
    ports.taskStore.listByWorkspace(workspaceId),
  ]);
  const teamTreeIds = collectTeamTreeSessionIds(sessions, workspaceId);
  return findUnassignedHistoricalCardIds(tasks, teamTreeIds);
}

/** Count/list the workspace's unassigned historical cards (read-only). */
export async function previewUnassignedHistoricalCards(
  ports: UnassignedCardsPorts,
  workspaceId: string,
): Promise<UnassignedHistoricalCardsPreview> {
  const taskIds = await resolveUnassignedTaskIds(ports, workspaceId);
  return { workspaceId, taskIds };
}

/**
 * Delete the workspace's unassigned historical cards. The target set is
 * recomputed at deletion time (a stale preview never widens the blast
 * radius). Only task records are removed — never codebases, repositories,
 * worktrees, artifacts, notes or sessions.
 */
export async function deleteUnassignedHistoricalCards(
  ports: UnassignedCardsPorts,
  workspaceId: string,
): Promise<UnassignedHistoricalCardsDeletionResult> {
  const taskIds = await resolveUnassignedTaskIds(ports, workspaceId);
  if (taskIds.length === 0) {
    return { workspaceId, deletedTaskIds: [] };
  }

  const driver = getDatabaseDriver();
  if (driver === "memory") {
    for (const taskId of taskIds) {
      await ports.taskStore.delete(taskId);
    }
  } else if (driver === "postgres") {
    const db = getPostgresDatabase();
    const where = and(
      inArray(pgSchema.tasks.id, taskIds),
      eq(pgSchema.tasks.workspaceId, workspaceId),
    );
    // Mirrors the driver selection in src/core/db/index.ts: Neon endpoints use
    // the neon-http driver, everything else uses postgres-js.
    const databaseUrl = process.env.DATABASE_URL ?? "";
    const isNeon = databaseUrl.includes("neon.tech") || databaseUrl.includes(".neon.database");
    if (isNeon) {
      // neon-http does not support interactive transactions, but batch()
      // sends all statements in one request and Neon executes them as a
      // single atomic transaction.
      await db.batch([db.delete(pgSchema.tasks).where(where)] as unknown as Parameters<typeof db.batch>[0]);
    } else {
      await db.transaction(async (tx) => {
        await tx.delete(pgSchema.tasks).where(where);
      });
    }
  } else {
    // sqlite — loaded dynamically so better-sqlite3 never lands in web bundles.
    const { getSqliteDatabase } = await import("@/core/db/sqlite");
    const sqliteSchema = await import("@/core/db/sqlite-schema");
    const db = getSqliteDatabase();
    // better-sqlite3 is synchronous — keep the callback synchronous so the
    // transaction wraps the delete.
    db.transaction((tx) => {
      tx.delete(sqliteSchema.tasks)
        .where(
          and(
            inArray(sqliteSchema.tasks.id, taskIds),
            eq(sqliteSchema.tasks.workspaceId, workspaceId),
          ),
        )
        .run();
    });
  }

  for (const taskId of taskIds) {
    ports.notifyTaskDeleted?.(workspaceId, taskId);
  }

  return { workspaceId, deletedTaskIds: taskIds };
}
