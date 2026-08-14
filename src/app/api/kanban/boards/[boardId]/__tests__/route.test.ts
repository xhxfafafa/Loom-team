import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KanbanBoard } from "@/core/models/kanban";

const notify = vi.fn();
const getBoardSnapshot = vi.fn();

const boardStore = {
  get: vi.fn<(boardId: string) => Promise<KanbanBoard | undefined>>(),
  save: vi.fn<(board: KanbanBoard) => Promise<void>>(),
  setDefault: vi.fn<(workspaceId: string, boardId: string) => Promise<void>>(),
};

const workspaceStore = {
  get: vi.fn<(workspaceId: string) => Promise<{ metadata?: Record<string, string> } | undefined>>(),
  updateMetadata: vi.fn<(workspaceId: string, metadata: Record<string, unknown>) => Promise<void>>(),
};

// Stateful metadata round-trip: PATCH re-reads the workspace after
// updateMetadata, so the get mock must see what updateMetadata stored.
let currentWorkspaceMetadata: Record<string, string> = {};

function wireWorkspaceMetadataRoundTrip() {
  workspaceStore.get.mockImplementation(async () => ({ metadata: currentWorkspaceMetadata }));
  workspaceStore.updateMetadata.mockImplementation(async (_workspaceId, metadata) => {
    currentWorkspaceMetadata = metadata as Record<string, string>;
  });
}

const system = {
  kanbanBoardStore: boardStore,
  workspaceStore,
};

vi.mock("@/core/routa-system", () => ({
  getRoutaSystem: () => system,
}));

vi.mock("@/core/kanban/kanban-event-broadcaster", () => ({
  getKanbanEventBroadcaster: () => ({ notify }),
}));

vi.mock("@/core/kanban/workflow-orchestrator-singleton", () => ({
  getKanbanSessionQueue: () => ({ getBoardSnapshot }),
}));

import { GET, PATCH } from "../route";

function boardFixture(overrides?: Partial<KanbanBoard>): KanbanBoard {
  return {
    id: "board-1",
    workspaceId: "workspace-1",
    name: "Release Board",
    isDefault: false,
    columns: [{ id: "backlog", name: "Backlog", position: 0, stage: "backlog" }],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function callGet(boardId: string) {
  const request = new NextRequest(`http://localhost/api/kanban/boards/${boardId}`);
  return GET(request, { params: Promise.resolve({ boardId }) });
}

function callPatch(boardId: string, body: unknown, options?: { rawBody?: string }) {
  const request = new NextRequest(`http://localhost/api/kanban/boards/${boardId}`, {
    method: "PATCH",
    body: options?.rawBody ?? JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return PATCH(request, { params: Promise.resolve({ boardId }) });
}

describe("GET /api/kanban/boards/{boardId}", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMetadata = {};
    wireWorkspaceMetadataRoundTrip();
    getBoardSnapshot.mockResolvedValue({ boardId: "board-1", runningCount: 0, runningCards: [] });
  });

  it("returns the sanitized board and never leaks the raw github token", async () => {
    boardStore.get.mockResolvedValue(boardFixture({ githubToken: "ghp_super_secret_token" }));

    const response = await callGet("board-1");

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.board.id).toBe("board-1");
    expect(data.board.name).toBe("Release Board");
    expect(data.board.githubToken).toBeUndefined();
    expect(data.board.githubTokenConfigured).toBe(true);
    expect(JSON.stringify(data)).not.toContain("ghp_super_secret_token");
  });

  it("reports githubTokenConfigured false when no token is stored", async () => {
    boardStore.get.mockResolvedValue(boardFixture());

    const response = await callGet("board-1");

    const data = await response.json();
    expect(data.board.githubTokenConfigured).toBe(false);
  });

  it("includes board-level metadata and queue snapshot", async () => {
    boardStore.get.mockResolvedValue(boardFixture());
    workspaceStore.get.mockResolvedValue({
      metadata: { "kanbanAutoProvider:board-1": "codex" },
    });
    getBoardSnapshot.mockResolvedValue({ boardId: "board-1", runningCount: 2, runningCards: ["task-1"] });

    const response = await callGet("board-1");

    const data = await response.json();
    expect(data.board.autoProviderId).toBe("codex");
    expect(data.board.queue).toMatchObject({ runningCount: 2 });
  });

  it("returns 404 for an unknown board", async () => {
    boardStore.get.mockResolvedValue(undefined);

    const response = await callGet("missing-board");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Board not found" });
  });
});

describe("PATCH /api/kanban/boards/{boardId}", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMetadata = {};
    wireWorkspaceMetadataRoundTrip();
    boardStore.get.mockResolvedValue(boardFixture());
    boardStore.save.mockResolvedValue(undefined);
    boardStore.setDefault.mockResolvedValue(undefined);
    getBoardSnapshot.mockResolvedValue({ boardId: "board-1", runningCount: 0, runningCards: [] });
  });

  it("renames the board, persists it, and emits a board updated event", async () => {
    const response = await callPatch("board-1", { name: "  Renamed Board  " });

    expect(response.status).toBe(200);
    const saved = boardStore.save.mock.calls[0]?.[0];
    expect(saved?.name).toBe("Renamed Board");
    const data = await response.json();
    expect(data.board.name).toBe("Renamed Board");
    expect(notify).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      entity: "board",
      action: "updated",
      resourceId: "board-1",
      source: "user",
    });
  });

  it("stores a new github token but never returns it raw", async () => {
    const response = await callPatch("board-1", { githubToken: "ghp_new_token" });

    expect(response.status).toBe(200);
    const saved = boardStore.save.mock.calls[0]?.[0];
    expect(saved?.githubToken).toBe("ghp_new_token");
    const data = await response.json();
    expect(data.board.githubToken).toBeUndefined();
    expect(data.board.githubTokenConfigured).toBe(true);
    expect(JSON.stringify(data)).not.toContain("ghp_new_token");
  });

  it("clears the github token when clearGitHubToken is set", async () => {
    boardStore.get.mockResolvedValue(boardFixture({ githubToken: "ghp_old_token" }));

    const response = await callPatch("board-1", { clearGitHubToken: true });

    expect(response.status).toBe(200);
    const saved = boardStore.save.mock.calls[0]?.[0];
    expect(saved?.githubToken).toBeUndefined();
    const data = await response.json();
    expect(data.board.githubTokenConfigured).toBe(false);
  });

  it("replaces columns when provided", async () => {
    const columns = [
      { id: "todo", name: "Todo", position: 0, stage: "backlog" },
      { id: "done", name: "Done", position: 1, stage: "done" },
    ];

    await callPatch("board-1", { columns });

    const saved = boardStore.save.mock.calls[0]?.[0];
    expect(saved?.columns.map((column) => column.id)).toEqual(["todo", "done"]);
  });

  it("promotes the board to default via the store", async () => {
    const response = await callPatch("board-1", { isDefault: true });

    expect(response.status).toBe(200);
    expect(boardStore.setDefault).toHaveBeenCalledWith("workspace-1", "board-1");
    const data = await response.json();
    expect(data.board.isDefault).toBe(true);
  });

  it("persists board-scoped workspace metadata for auto provider and concurrency", async () => {
    const response = await callPatch("board-1", {
      autoProviderId: "claude",
      sessionConcurrencyLimit: 3,
    });

    expect(response.status).toBe(200);
    expect(workspaceStore.updateMetadata).toHaveBeenCalledTimes(1);
    const [workspaceId, metadata] = workspaceStore.updateMetadata.mock.calls[0] ?? [];
    expect(workspaceId).toBe("workspace-1");
    expect(metadata).toMatchObject({
      "kanbanAutoProvider:board-1": "claude",
      "kanbanSessionConcurrencyLimit:board-1": "3",
    });
    const data = await response.json();
    expect(data.board.autoProviderId).toBe("claude");
    expect(data.board.sessionConcurrencyLimit).toBe(3);
  });

  it("returns 404 for an unknown board", async () => {
    boardStore.get.mockResolvedValue(undefined);

    const response = await callPatch("missing-board", { name: "Nope" });

    expect(response.status).toBe(404);
    expect(boardStore.save).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON bodies", async () => {
    const response = await callPatch("board-1", {}, { rawBody: "{broken" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
    expect(boardStore.save).not.toHaveBeenCalled();
  });
});
