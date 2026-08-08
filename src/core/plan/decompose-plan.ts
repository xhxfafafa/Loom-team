/**
 * Plan Decomposition
 *
 * Maps confirmed DevPlan user stories onto Kanban tasks on the default board.
 * Reuses the existing task store + ensureDefaultBoard helpers — does NOT
 * reimplement any kanban logic.
 *
 * Called from the POST /api/plans/[planId]/confirm route only.
 */

import { v4 as uuidv4 } from "uuid";
import { createTask } from "../models/task";
import { columnIdToTaskStatus } from "../models/kanban";
import { ensureDefaultBoard } from "../kanban/boards";
import type { DevPlan, DevPlanUserStory } from "./dev-plan";
import type { RoutaSystem } from "./decomposition-types";

export interface DecomposePlanResult {
  boardId: string;
  createdTaskIds: string[];
}

/**
 * Create one Task per user story on the workspace's default board (backlog).
 * The task title/objective/acceptanceCriteria are derived from the story.
 */
export async function decomposePlanToTasks(
  system: RoutaSystem,
  plan: DevPlan,
): Promise<DecomposePlanResult> {
  const board = await ensureDefaultBoard(system, plan.workspaceId);
  const columnId = "backlog";

  const existingTasks = await system.taskStore.listByWorkspace(plan.workspaceId);
  const columnTasks = existingTasks.filter(
    (t) => t.boardId === board.id && (t.columnId ?? "backlog") === columnId,
  );
  let position = columnTasks.length;

  const createdTaskIds: string[] = [];

  for (const story of plan.userStories) {
    const task = buildTaskFromStory(plan, story, board.id, columnId, position++);
    await system.taskStore.save(task);
    createdTaskIds.push(task.id);
  }

  return { boardId: board.id, createdTaskIds };
}

function buildTaskFromStory(
  plan: DevPlan,
  story: DevPlanUserStory,
  boardId: string,
  columnId: string,
  position: number,
) {
  const objective = `${story.story}\n\nPlan: ${plan.id}`;
  return createTask({
    id: uuidv4(),
    title: story.title,
    objective,
    workspaceId: plan.workspaceId,
    boardId,
    columnId,
    position,
    status: columnIdToTaskStatus(columnId),
    acceptanceCriteria: story.acceptanceCriteria.length
      ? story.acceptanceCriteria
      : undefined,
    labels: ["plan-generated"],
  });
}
