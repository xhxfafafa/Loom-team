/**
 * /api/tasks/[taskId]/status - Update task status.
 *
 * POST /api/tasks/:taskId/status { status: "IN_PROGRESS" }
 */

import { NextRequest, NextResponse } from "next/server";
import { getRoutaSystem } from "@/core/routa-system";
import { TaskStatus } from "@/core/models/task";
import { taskStatusToColumnId } from "@/core/models/kanban";
import {
  applyTaskStatusTransition,
  isTerminalTaskStatus,
  loadTaskBoardColumns,
} from "@/core/kanban/task-status-transition";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;
  const body = await request.json();
  const { status } = body;

  if (!status) {
    return NextResponse.json({ error: "status is required" }, { status: 400 });
  }

  const taskStatus = status.toUpperCase() as TaskStatus;
  if (!Object.values(TaskStatus).includes(taskStatus)) {
    return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 });
  }

  const system = getRoutaSystem();
  const task = await system.taskStore.get(taskId);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  if (isTerminalTaskStatus(taskStatus)) {
    // Terminal writes must keep status and the Kanban projection consistent
    // in one write: resolve the board's done/blocked stage column instead of
    // writing a literal (potentially phantom) column id.
    const boardColumns = await loadTaskBoardColumns(system, task);
    applyTaskStatusTransition(task, taskStatus, boardColumns);
  } else {
    // Non-terminal statuses keep the historical status-to-column mapping.
    task.status = taskStatus;
    task.columnId = taskStatusToColumnId(taskStatus);
    task.updatedAt = new Date();
  }
  await system.taskStore.save(task);

  return NextResponse.json({ updated: true });
}
