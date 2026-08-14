import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.fn();

const boardStore = {
  save: vi.fn<(_: unknown) => Promise<void>>(),
  setDefault: vi.fn<(_: string, boardId: string) => Promise<void>>(),
};

const system = {
  kanbanBoardStore: boardStore,
};

vi.mock("@/core/routa-system", () => ({
  getRoutaSystem: () => system,
}));

vi.mock("@/core/kanban/kanban-event-broadcaster", () => ({
  getKanbanEventBroadcaster: () => ({ notify }),
}));

vi.mock("uuid", () => ({
  v4: () => "board-generated-id",
}));

import { POST } from "../route";

function callPost(body: unknown, options?: { rawBody?: string }) {
  const request = new NextRequest("http://localhost/api/kanban/boards", {
    method: "POST",
    body: options?.rawBody ?? JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return POST(request);
}

describe("POST /api/kanban/boards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boardStore.save.mockResolvedValue(undefined);
    boardStore.setDefault.mockResolvedValue(undefined);
  });

  it("creates a board with default columns and sanitizes the response", async () => {
    const response = await callPost({ workspaceId: "workspace-1", name: "  Release Board  " });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.board.id).toBe("board-generated-id");
    expect(data.board.workspaceId).toBe("workspace-1");
    expect(data.board.name).toBe("Release Board");
    expect(data.board.isDefault).toBe(false);
    expect(Array.isArray(data.board.columns)).toBe(true);
    expect(data.board.columns.length).toBeGreaterThan(0);
    expect(data.board.createdAt).toBeDefined();
    expect(data.board.updatedAt).toBeDefined();
    // Token fields are never exposed raw.
    expect(data.board.githubToken).toBeUndefined();
    expect(data.board.githubTokenConfigured).toBe(false);

    expect(boardStore.save).toHaveBeenCalledTimes(1);
    expect(boardStore.setDefault).not.toHaveBeenCalled();
  });

  it("emits a board created kanban event", async () => {
    await callPost({ workspaceId: "workspace-1", name: "Events Board" });

    expect(notify).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      entity: "board",
      action: "created",
      resourceId: "board-generated-id",
      source: "user",
    });
  });

  it("marks the board default and updates the default pointer when requested", async () => {
    const response = await callPost({
      workspaceId: "workspace-1",
      name: "Primary",
      isDefault: true,
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.board.isDefault).toBe(true);
    expect(boardStore.setDefault).toHaveBeenCalledWith("workspace-1", "board-generated-id");
  });

  it("honors caller-provided columns", async () => {
    const columns = [
      { id: "todo", name: "Todo", position: 0, stage: "backlog" },
      { id: "done", name: "Done", position: 1, stage: "done" },
    ];
    const response = await callPost({ workspaceId: "workspace-1", name: "Custom", columns });

    const data = await response.json();
    expect(data.board.columns.map((column: { id: string }) => column.id)).toEqual(["todo", "done"]);
  });

  it("rejects missing workspaceId", async () => {
    const response = await callPost({ name: "No Workspace" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "workspaceId is required" });
    expect(boardStore.save).not.toHaveBeenCalled();
  });

  it("rejects blank workspaceId", async () => {
    const response = await callPost({ workspaceId: "   ", name: "Blank" });
    expect(response.status).toBe(400);
    expect(boardStore.save).not.toHaveBeenCalled();
  });

  it("rejects missing name", async () => {
    const response = await callPost({ workspaceId: "workspace-1" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "name is required" });
    expect(boardStore.save).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON bodies", async () => {
    const response = await callPost({}, { rawBody: "{not-json" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
  });
});
