import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTask, TaskStatus, type Task } from "@/core/models/task";

const taskStore = {
  get: vi.fn<(_: string) => Promise<Task | undefined>>(),
  save: vi.fn<(task: Task) => Promise<void>>(),
};

const kanbanBoardStore = {
  get: vi.fn<(_: string) => Promise<unknown>>(),
  getDefault: vi.fn<(_: string) => Promise<unknown>>(),
};

const system = {
  taskStore,
  kanbanBoardStore,
};

vi.mock("@/core/routa-system", () => ({
  getRoutaSystem: () => system,
}));

import { POST } from "../route";

function postStatus(status: string) {
  return POST(
    new NextRequest("http://localhost/api/tasks/task-1/status", {
      method: "POST",
      body: JSON.stringify({ status }),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ taskId: "task-1" }) },
  );
}

describe("POST /api/tasks/[taskId]/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskStore.save.mockResolvedValue(undefined);
    kanbanBoardStore.get.mockResolvedValue(null);
    kanbanBoardStore.getDefault.mockResolvedValue(null);
  });

  it("rejects missing or invalid statuses", async () => {
    taskStore.get.mockResolvedValue(createTask({
      id: "task-1",
      title: "Task",
      objective: "Objective",
      workspaceId: "workspace-1",
    }));

    const missing = await POST(
      new NextRequest("http://localhost/api/tasks/task-1/status", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ taskId: "task-1" }) },
    );
    expect(missing.status).toBe(400);

    const invalid = await postStatus("NOT_A_STATUS");
    expect(invalid.status).toBe(400);
  });

  it("returns 404 for unknown tasks", async () => {
    taskStore.get.mockResolvedValue(undefined);
    const response = await postStatus("COMPLETED");
    expect(response.status).toBe(404);
    expect(taskStore.save).not.toHaveBeenCalled();
  });

  it("moves COMPLETED onto the board's done-stage column in one write", async () => {
    taskStore.get.mockResolvedValue(createTask({
      id: "task-1",
      title: "Task",
      objective: "Objective",
      workspaceId: "workspace-1",
      boardId: "board-1",
      columnId: "dev",
      status: TaskStatus.IN_PROGRESS,
    }));
    kanbanBoardStore.get.mockResolvedValue({
      id: "board-1",
      columns: [
        { id: "backlog", name: "Backlog", position: 0, stage: "backlog" },
        { id: "dev", name: "Dev", position: 1, stage: "dev" },
        { id: "ship", name: "Ship", position: 2, stage: "done" },
      ],
    });

    const response = await postStatus("completed");
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ updated: true });
    expect(taskStore.save).toHaveBeenCalledWith(expect.objectContaining({
      status: TaskStatus.COMPLETED,
      columnId: "ship",
    }));
  });

  it("resolves BLOCKED against the board's blocked-stage column", async () => {
    taskStore.get.mockResolvedValue(createTask({
      id: "task-1",
      title: "Task",
      objective: "Objective",
      workspaceId: "workspace-1",
      boardId: "board-1",
      columnId: "dev",
      status: TaskStatus.IN_PROGRESS,
    }));
    kanbanBoardStore.get.mockResolvedValue({
      id: "board-1",
      columns: [
        { id: "dev", name: "Dev", position: 0, stage: "dev" },
        { id: "stuck", name: "Stuck", position: 1, stage: "blocked" },
      ],
    });

    const response = await postStatus("BLOCKED");

    expect(response.status).toBe(200);
    expect(taskStore.save).toHaveBeenCalledWith(expect.objectContaining({
      status: TaskStatus.BLOCKED,
      columnId: "stuck",
    }));
  });

  it("keeps a valid current column when the board has no terminal stage", async () => {
    taskStore.get.mockResolvedValue(createTask({
      id: "task-1",
      title: "Task",
      objective: "Objective",
      workspaceId: "workspace-1",
      boardId: "board-1",
      columnId: "custom-lane",
      status: TaskStatus.IN_PROGRESS,
    }));
    kanbanBoardStore.get.mockResolvedValue({
      id: "board-1",
      columns: [{ id: "custom-lane", name: "Custom", position: 0, stage: "custom" }],
    });

    await postStatus("COMPLETED");

    expect(taskStore.save).toHaveBeenCalledWith(expect.objectContaining({
      status: TaskStatus.COMPLETED,
      columnId: "custom-lane",
    }));
  });

  it("falls back to the literal terminal id without board context", async () => {
    taskStore.get.mockResolvedValue(createTask({
      id: "task-1",
      title: "Task",
      objective: "Objective",
      workspaceId: "workspace-1",
      columnId: "",
      status: TaskStatus.IN_PROGRESS,
    }));

    await postStatus("COMPLETED");

    expect(kanbanBoardStore.getDefault).toHaveBeenCalledWith("workspace-1");
    expect(taskStore.save).toHaveBeenCalledWith(expect.objectContaining({
      status: TaskStatus.COMPLETED,
      columnId: "done",
    }));
  });

  it("keeps the historical status-to-column mapping for non-terminal statuses", async () => {
    taskStore.get.mockResolvedValue(createTask({
      id: "task-1",
      title: "Task",
      objective: "Objective",
      workspaceId: "workspace-1",
      boardId: "board-1",
      columnId: "backlog",
      status: TaskStatus.PENDING,
    }));

    await postStatus("IN_PROGRESS");

    expect(taskStore.save).toHaveBeenCalledWith(expect.objectContaining({
      status: TaskStatus.IN_PROGRESS,
      columnId: "dev",
    }));
  });
});
