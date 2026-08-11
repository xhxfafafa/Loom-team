import { resolveColumnIdForSemanticStage, type KanbanColumn } from "../models/kanban";
import type { Task } from "../models/task";
import { resolveCurrentLaneAutomationState } from "./lane-automation-state";

type ReviewConvergenceTask = Pick<
  Task,
  | "columnId"
  | "verificationVerdict"
  | "triggerSessionId"
  | "laneSessions"
  | "laneHandoffs"
  | "assignedProvider"
  | "assignedRole"
  | "assignedSpecialistId"
  | "assignedSpecialistName"
>;

function isReviewStage(task: ReviewConvergenceTask, boardColumns: KanbanColumn[]): boolean {
  const currentColumn = boardColumns.find((column) => column.id === task.columnId);
  return currentColumn?.stage === "review" || task.columnId === "review";
}

export function resolveReviewLaneConvergenceTarget(
  task: ReviewConvergenceTask,
  boardColumns: KanbanColumn[] = [],
): string | undefined {
  if (!task.verificationVerdict || !isReviewStage(task, boardColumns)) {
    return undefined;
  }

  const laneAutomationState = resolveCurrentLaneAutomationState(task, boardColumns);
  if (laneAutomationState.hasRemainingSteps) {
    return undefined;
  }

  switch (task.verificationVerdict) {
    case "APPROVED":
      return resolveColumnIdForSemanticStage(boardColumns, "done") ?? "done";
    case "NOT_APPROVED":
      return resolveColumnIdForSemanticStage(boardColumns, "dev") ?? "dev";
    case "BLOCKED":
      return resolveColumnIdForSemanticStage(boardColumns, "blocked") ?? "blocked";
    default:
      return undefined;
  }
}
