import { resolveColumnIdForSemanticStage, taskStatusToColumnId, type KanbanColumn } from "../models/kanban";
import { TaskStatus, type Task } from "../models/task";
import type { KanbanBoardStore } from "../store/kanban-board-store";

/**
 * Status transition helper that keeps Task.status and its Kanban projection
 * consistent in one write.
 *
 * Every production entry point that can write a terminal status on a
 * Kanban-visible task must route through applyTaskStatusTransition (or an
 * equivalent store-level operation) instead of assigning status alone.
 */

/**
 * Minimal column shape shared by write-side transitions and read-side
 * resolution. `stage` is a plain string so both the persisted KanbanColumn
 * and the UI-facing KanbanColumnInfo satisfy it.
 */
export type TransitionColumn = { id: string; stage: string };

/** Statuses that map onto a terminal Kanban stage. */
export function isTerminalTaskStatus(status: TaskStatus | string | undefined): boolean {
  const normalized = (status ?? "").toString().toUpperCase();
  return normalized === TaskStatus.COMPLETED || normalized === TaskStatus.BLOCKED;
}

/**
 * Resolve the column a terminal status should land on.
 *
 * Resolution order:
 * 1. no board context loadable -> literal stage id (legacy fallback);
 * 2. the board column whose semantic stage matches (done/blocked);
 * 3. a literal done/blocked column when that column exists on the board;
 * 4. keep the task's current column when it is a valid column of the board
 *    (return undefined so callers preserve it);
 * 5. the board's Backlog column;
 * 6. never write a phantom column id (return undefined).
 *
 * NEEDS_FIX intentionally receives no automatic column mapping: it is not a
 * terminal status and its desired board stage is a separate product decision.
 */
export function resolveTerminalColumnIdForStatus(
  boardColumns: TransitionColumn[] | undefined,
  status: TaskStatus,
  currentColumnId?: string,
): string | undefined {
  let stage: "done" | "blocked" | undefined;
  if (status === TaskStatus.COMPLETED) stage = "done";
  else if (status === TaskStatus.BLOCKED) stage = "blocked";
  if (!stage) return undefined;

  if (!boardColumns || boardColumns.length === 0) {
    // No board context can be loaded: fall back to the literal stage id.
    return stage;
  }

  const semantic = resolveColumnIdForSemanticStage(boardColumns, stage);
  if (semantic) return semantic;

  const literal = boardColumns.find((column) => column.id === stage)?.id;
  if (literal) return literal;

  if (currentColumnId && boardColumns.some((column) => column.id === currentColumnId)) {
    // Preserve the valid current column rather than writing a phantom id.
    return undefined;
  }

  return (
    resolveColumnIdForSemanticStage(boardColumns, "backlog") ??
    boardColumns.find((column) => column.id === "backlog")?.id
  );
}

/**
 * Apply a status transition to a task: update the status, resolve the
 * matching terminal column when applicable, and refresh updatedAt. The caller
 * performs one final save.
 */
export function applyTaskStatusTransition(
  task: Task,
  nextStatus: TaskStatus,
  boardColumns: TransitionColumn[] | undefined,
): void {
  task.status = nextStatus;
  const columnId = resolveTerminalColumnIdForStatus(boardColumns, nextStatus, task.columnId);
  if (columnId !== undefined) {
    task.columnId = columnId;
  }
  task.updatedAt = new Date();
}

/**
 * Load the board columns for a task's board context:
 * 1. the task's boardId board;
 * 2. the workspace default board when boardId is absent or missing;
 * 3. undefined when no board context can be loaded.
 *
 * This helper never creates boards: the transition must stay read-only on
 * board state.
 */
export async function loadTaskBoardColumns(
  system: { kanbanBoardStore: Pick<KanbanBoardStore, "get" | "getDefault"> | undefined },
  task: Pick<Task, "boardId" | "workspaceId">,
): Promise<KanbanColumn[] | undefined> {
  try {
    const store = system.kanbanBoardStore;
    if (!store) return undefined;
    if (task.boardId) {
      const board = await store.get(task.boardId);
      if (board && board.columns.length > 0) return board.columns;
    }
    const defaultBoard = await store.getDefault(task.workspaceId);
    if (defaultBoard && defaultBoard.columns.length > 0) return defaultBoard.columns;
    return undefined;
  } catch {
    return undefined;
  }
}

// ─── Historical read compatibility ─────────────────────────────────────────
//
// Read-side resolution never mutates tasks. It lets every consumer agree on
// where a task lives and whether it is terminal even when historical rows
// carry a terminal status with an empty or stale columnId (and vice versa).

/**
 * Resolve the column a task should be displayed/grouped in.
 *
 * Precedence:
 * 1. terminal task.status → the board's matching terminal column (done for
 *    COMPLETED, blocked for BLOCKED); this is what makes historical
 *    `COMPLETED + empty columnId` rows render in Done;
 * 2. the task's explicit columnId;
 * 3. status-to-column fallback (never blocks the read path).
 */
export function resolveEffectiveColumnIdForRead(
  task: { status: TaskStatus | string; columnId?: string },
  boardColumns: TransitionColumn[] | undefined,
): string {
  if (isTerminalTaskStatus(task.status)) {
    const terminalColumnId = resolveTerminalColumnIdForStatus(
      boardColumns,
      task.status as TaskStatus,
      task.columnId,
    );
    if (terminalColumnId !== undefined) return terminalColumnId;
    if (task.columnId) return task.columnId;
  }

  if (task.columnId) return task.columnId;
  return taskStatusToColumnId(task.status);
}

/**
 * Whether a task must be treated as terminal for display and Run-eligibility.
 *
 * Precedence:
 * 1. terminal task.status always wins (a COMPLETED task is terminal even if
 *    its columnId is empty or stale);
 * 2. a column whose semantic stage is done/blocked on the loaded board;
 * 3. the literal done/blocked columnId when no board context is available.
 */
export function isTaskTerminalForRead(
  task: { status: TaskStatus | string; columnId?: string },
  boardColumns: TransitionColumn[] | undefined,
): boolean {
  if (isTerminalTaskStatus(task.status)) return true;

  const columnId = task.columnId;
  if (!columnId) return false;

  if (boardColumns && boardColumns.length > 0) {
    const column = boardColumns.find((entry) => entry.id === columnId);
    if (column) {
      return column.stage === "done" || column.stage === "blocked";
    }
  }

  return columnId === "done" || columnId === "blocked";
}
