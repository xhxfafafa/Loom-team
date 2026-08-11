import { describe, expect, it } from "vitest";
import { createTask, TaskStatus } from "../../models/task";
import {
  applyTaskStatusTransition,
  isTaskTerminalForRead,
  isTerminalTaskStatus,
  resolveEffectiveColumnIdForRead,
  resolveTerminalColumnIdForStatus,
} from "../task-status-transition";

const fullBoard = [
  { id: "backlog", stage: "backlog" },
  { id: "todo", stage: "todo" },
  { id: "dev", stage: "dev" },
  { id: "review", stage: "review" },
  { id: "ship", stage: "done" },
  { id: "stuck", stage: "blocked" },
];

function buildTask(overrides?: { status?: TaskStatus; columnId?: string }) {
  return createTask({
    id: "task-1",
    title: "Transition fixture",
    objective: "Keep status and column consistent.",
    workspaceId: "workspace-1",
    boardId: "board-1",
    columnId: overrides?.columnId ?? "dev",
    status: overrides?.status ?? TaskStatus.IN_PROGRESS,
  });
}

describe("isTerminalTaskStatus", () => {
  it("treats only COMPLETED and BLOCKED as terminal", () => {
    expect(isTerminalTaskStatus(TaskStatus.COMPLETED)).toBe(true);
    expect(isTerminalTaskStatus(TaskStatus.BLOCKED)).toBe(true);
    expect(isTerminalTaskStatus(TaskStatus.NEEDS_FIX)).toBe(false);
    expect(isTerminalTaskStatus(TaskStatus.IN_PROGRESS)).toBe(false);
    expect(isTerminalTaskStatus(TaskStatus.PENDING)).toBe(false);
    expect(isTerminalTaskStatus(TaskStatus.CANCELLED)).toBe(false);
  });

  it("normalizes casing for serialized statuses", () => {
    expect(isTerminalTaskStatus("completed")).toBe(true);
    expect(isTerminalTaskStatus("Blocked")).toBe(true);
    expect(isTerminalTaskStatus(undefined)).toBe(false);
  });
});

describe("resolveTerminalColumnIdForStatus", () => {
  it("resolves COMPLETED to the board column carrying the done stage", () => {
    expect(resolveTerminalColumnIdForStatus(fullBoard, TaskStatus.COMPLETED, "dev")).toBe("ship");
  });

  it("resolves BLOCKED to the board column carrying the blocked stage", () => {
    expect(resolveTerminalColumnIdForStatus(fullBoard, TaskStatus.BLOCKED, "dev")).toBe("stuck");
  });

  it("falls back to the literal stage id when no board context is loadable", () => {
    expect(resolveTerminalColumnIdForStatus(undefined, TaskStatus.COMPLETED)).toBe("done");
    expect(resolveTerminalColumnIdForStatus([], TaskStatus.BLOCKED)).toBe("blocked");
  });

  it("matches a literal done column when no semantic stage column exists", () => {
    const board = [
      { id: "backlog", stage: "backlog" },
      { id: "done", stage: "custom" },
    ];
    expect(resolveTerminalColumnIdForStatus(board, TaskStatus.COMPLETED)).toBe("done");
  });

  it("keeps a valid current column instead of writing a phantom id", () => {
    const board = [{ id: "custom-lane", stage: "custom" }];
    expect(resolveTerminalColumnIdForStatus(board, TaskStatus.COMPLETED, "custom-lane")).toBeUndefined();
  });

  it("falls back to the board Backlog column when the current column is invalid", () => {
    const board = [
      { id: "inbox", stage: "backlog" },
      { id: "custom-lane", stage: "custom" },
    ];
    expect(resolveTerminalColumnIdForStatus(board, TaskStatus.COMPLETED, "ghost")).toBe("inbox");
  });

  it("never maps NEEDS_FIX automatically", () => {
    expect(resolveTerminalColumnIdForStatus(fullBoard, TaskStatus.NEEDS_FIX, "dev")).toBeUndefined();
  });
});

describe("applyTaskStatusTransition", () => {
  it("moves a completed task onto the done-stage column in one write", () => {
    const task = buildTask({ status: TaskStatus.IN_PROGRESS, columnId: "dev" });
    const before = task.updatedAt;
    applyTaskStatusTransition(task, TaskStatus.COMPLETED, fullBoard);
    expect(task.status).toBe(TaskStatus.COMPLETED);
    expect(task.columnId).toBe("ship");
    expect(task.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("preserves the column for NEEDS_FIX writes", () => {
    const task = buildTask({ status: TaskStatus.IN_PROGRESS, columnId: "review" });
    applyTaskStatusTransition(task, TaskStatus.NEEDS_FIX, fullBoard);
    expect(task.status).toBe(TaskStatus.NEEDS_FIX);
    expect(task.columnId).toBe("review");
  });

  it("keeps a valid current column when the board has no terminal stage", () => {
    const board = [{ id: "custom-lane", stage: "custom" }];
    const task = buildTask({ status: TaskStatus.IN_PROGRESS, columnId: "custom-lane" });
    applyTaskStatusTransition(task, TaskStatus.COMPLETED, board);
    expect(task.status).toBe(TaskStatus.COMPLETED);
    expect(task.columnId).toBe("custom-lane");
  });
});

describe("resolveEffectiveColumnIdForRead", () => {
  it("renders historical COMPLETED rows with empty columnId in Done", () => {
    const task = buildTask({ status: TaskStatus.COMPLETED, columnId: "" });
    expect(resolveEffectiveColumnIdForRead(task, fullBoard)).toBe("ship");
  });

  it("lets terminal status win over a stale columnId", () => {
    const task = buildTask({ status: TaskStatus.COMPLETED, columnId: "dev" });
    expect(resolveEffectiveColumnIdForRead(task, fullBoard)).toBe("ship");
  });

  it("prefers the explicit column for non-terminal statuses", () => {
    const task = buildTask({ status: TaskStatus.IN_PROGRESS, columnId: "review" });
    expect(resolveEffectiveColumnIdForRead(task, fullBoard)).toBe("review");
  });

  it("falls back to the status-to-column mapping when columnId is empty", () => {
    expect(resolveEffectiveColumnIdForRead({ status: TaskStatus.IN_PROGRESS, columnId: "" }, fullBoard)).toBe("dev");
    expect(resolveEffectiveColumnIdForRead({ status: TaskStatus.REVIEW_REQUIRED, columnId: "" }, fullBoard)).toBe("review");
    expect(resolveEffectiveColumnIdForRead({ status: TaskStatus.PENDING, columnId: "" }, fullBoard)).toBe("backlog");
  });

  it("uses the literal terminal column when no board context is available", () => {
    expect(resolveEffectiveColumnIdForRead({ status: TaskStatus.BLOCKED, columnId: "" }, undefined)).toBe("blocked");
  });
});

describe("isTaskTerminalForRead", () => {
  it("treats a terminal status as terminal regardless of columnId", () => {
    expect(isTaskTerminalForRead({ status: TaskStatus.COMPLETED, columnId: "dev" }, fullBoard)).toBe(true);
    expect(isTaskTerminalForRead({ status: TaskStatus.BLOCKED, columnId: "" }, fullBoard)).toBe(true);
  });

  it("treats done/blocked stage columns as terminal for non-terminal statuses", () => {
    expect(isTaskTerminalForRead({ status: TaskStatus.IN_PROGRESS, columnId: "ship" }, fullBoard)).toBe(true);
    expect(isTaskTerminalForRead({ status: TaskStatus.IN_PROGRESS, columnId: "stuck" }, fullBoard)).toBe(true);
    expect(isTaskTerminalForRead({ status: TaskStatus.IN_PROGRESS, columnId: "dev" }, fullBoard)).toBe(false);
  });

  it("trusts board semantics over literal column ids", () => {
    const board = [{ id: "done", stage: "dev" }];
    expect(isTaskTerminalForRead({ status: TaskStatus.IN_PROGRESS, columnId: "done" }, board)).toBe(false);
  });

  it("falls back to literal done/blocked ids without board context", () => {
    expect(isTaskTerminalForRead({ status: TaskStatus.IN_PROGRESS, columnId: "done" }, undefined)).toBe(true);
    expect(isTaskTerminalForRead({ status: TaskStatus.IN_PROGRESS, columnId: "custom" }, undefined)).toBe(false);
  });

  it("treats tasks without a column as non-terminal", () => {
    expect(isTaskTerminalForRead({ status: TaskStatus.PENDING, columnId: "" }, fullBoard)).toBe(false);
  });
});
