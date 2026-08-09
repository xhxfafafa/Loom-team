import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE } from "../[rootSessionId]/route";
import { GET } from "../[rootSessionId]/preview/route";

const { state } = vi.hoisted(() => ({
  state: {
    sessions: [] as Array<Record<string, unknown>>,
    tasks: [] as Array<Record<string, unknown>>,
    deletedTasks: [] as string[],
    notified: [] as string[],
    throwOnList: false,
  },
}));

vi.mock("@/core/db/index", () => ({
  getDatabaseDriver: () => "memory",
  getPostgresDatabase: () => {
    throw new Error("postgres driver is not used in these tests");
  },
}));

vi.mock("../team-run-deletion-ports", () => ({
  createTeamRunDeletionPorts: () => ({
    listSessions: () => {
      if (state.throwOnList) throw new Error("session store exploded");
      return state.sessions;
    },
    hasActiveProcess: () => false,
    killSessionProcess: async () => {},
    system: {
      agentStore: { listByWorkspace: async () => [], delete: async () => {} },
      conversationStore: { deleteConversation: async () => {} },
      eventBus: { removeAgentData: () => {} },
      taskStore: {
        listByWorkspace: async () => state.tasks,
        delete: async (id: string) => {
          state.deletedTasks.push(id);
        },
      },
      artifactStore: { listByTask: async () => [], deleteByTask: async () => {} },
      worktreeStore: { listByWorkspace: async () => [], remove: async () => {} },
      noteStore: { listByWorkspace: async () => [], delete: async () => {} },
      backgroundTaskStore: { listByWorkspace: async () => [], delete: async () => {} },
    },
    clearInMemorySession: () => {},
    notifyTaskDeleted: (_workspaceId: string, taskId: string) => {
      state.notified.push(taskId);
    },
  }),
}));

function resetState() {
  state.sessions = [
    {
      sessionId: "root-1",
      name: "Team - Alpha",
      role: "ROUTA",
      cwd: "/tmp/project",
      workspaceId: "ws-1",
      parentSessionId: undefined,
    },
    {
      sessionId: "child-1",
      name: "worker-1",
      role: "ROUTA",
      cwd: "/tmp/project",
      workspaceId: "ws-1",
      parentSessionId: "root-1",
    },
    {
      sessionId: "solo-1",
      name: "Solo session",
      role: "claude",
      cwd: "/tmp/project",
      workspaceId: "ws-1",
    },
  ];
  state.tasks = [
    { id: "task-1", triggerSessionId: "root-1" },
    { id: "task-out", sessionId: "solo-1" },
  ];
  state.deletedTasks = [];
  state.notified = [];
  state.throwOnList = false;
}

beforeEach(resetState);

function callDelete(rootSessionId: string, init?: { search?: string; body?: unknown }) {
  const search = init?.search ?? (init?.body !== undefined ? "" : "?workspaceId=ws-1");
  const url = `http://localhost/api/team-runs/${rootSessionId}${search}`;
  const request =
    init?.body !== undefined
      ? new NextRequest(url, {
          method: "DELETE",
          body: JSON.stringify(init.body),
          headers: { "Content-Type": "application/json" },
        })
      : new NextRequest(url, { method: "DELETE" });
  return DELETE(request, { params: Promise.resolve({ rootSessionId }) });
}

function callPreview(rootSessionId: string, search = "") {
  const request = new NextRequest(
    `http://localhost/api/team-runs/${rootSessionId}/preview${search}`,
  );
  return GET(request, { params: Promise.resolve({ rootSessionId }) });
}

describe("DELETE /api/team-runs/:rootSessionId", () => {
  it("deletes the team tree and returns structured counts", async () => {
    const response = await callDelete("root-1");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.rootSessionId).toBe("root-1");
    expect(body.result.deleted.sessions).toBe(2);
    expect(body.result.deleted.kanbanCards).toBe(1);
    expect(body.result.preserved).toEqual({ sharedKanbanCards: 0, sharedWorktrees: 0 });
    expect(state.deletedTasks).toEqual(["task-1"]);
    expect(state.deletedTasks).not.toContain("task-out");
    expect(state.notified).toEqual(["task-1"]);
  });

  it("accepts the workspace guard as a query parameter", async () => {
    const response = await callDelete("root-1", { search: "?workspaceId=other-ws" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("TEAM_RUN_WORKSPACE_MISMATCH");
    expect(state.deletedTasks).toEqual([]);
  });

  it("requires the workspace guard for destructive requests", async () => {
    const response = await callDelete("root-1", { search: "" });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("TEAM_RUN_WORKSPACE_REQUIRED");
    expect(state.deletedTasks).toEqual([]);
  });

  it("accepts the workspace guard in the JSON body", async () => {
    const response = await callDelete("root-1", { body: { workspaceId: "other-ws" } });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("TEAM_RUN_WORKSPACE_MISMATCH");
  });

  it("rejects child sessions and non-team sessions with 409", async () => {
    const childResponse = await callDelete("child-1");
    expect(childResponse.status).toBe(409);
    expect((await childResponse.json()).error.code).toBe("TEAM_RUN_NOT_TEAM_ROOT");

    const soloResponse = await callDelete("solo-1");
    expect(soloResponse.status).toBe(409);
    expect((await soloResponse.json()).error.code).toBe("TEAM_RUN_NOT_TEAM_ROOT");

    expect(state.deletedTasks).toEqual([]);
  });

  it("returns 404 for unknown sessions", async () => {
    const response = await callDelete("ghost");
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("TEAM_RUN_NOT_FOUND");
    expect(body.error.details).toMatchObject({ rootSessionId: "ghost" });
  });

  it("returns a generic 500 for unexpected failures", async () => {
    state.throwOnList = true;
    const response = await callDelete("root-1");
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INTERNAL");
  });
});

describe("GET /api/team-runs/:rootSessionId/preview", () => {
  it("returns the server-computed impact preview without mutating anything", async () => {
    const response = await callPreview("root-1", "?workspaceId=ws-1");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.rootSessionId).toBe("root-1");
    expect(body.teamName).toBe("Team - Alpha");
    expect(body.workspaceId).toBe("ws-1");
    expect(body.counts).toEqual({
      sessions: 2,
      activeAgents: 0,
      kanbanCards: 1,
      explicitKanbanCards: 0,
      legacyKanbanCards: 1,
      artifacts: 0,
      worktrees: 0,
      notes: 0,
      backgroundTasks: 0,
      preservedSharedKanbanCards: 0,
      preservedSharedWorktrees: 0,
    });
    expect(body.hasRunnerSessions).toBe(false);
    expect(body.sessionIds).toEqual(["root-1", "child-1"]);
    expect(body.kanbanTaskIds).toEqual(["task-1"]);
    expect(body.sharedKanbanTaskIds).toEqual([]);
    expect(state.deletedTasks).toEqual([]);
  });

  it("maps validation errors to structured responses", async () => {
    const missing = await callPreview("ghost");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("TEAM_RUN_NOT_FOUND");

    const notRoot = await callPreview("solo-1");
    expect(notRoot.status).toBe(409);
    expect((await notRoot.json()).error.code).toBe("TEAM_RUN_NOT_TEAM_ROOT");

    const mismatch = await callPreview("root-1", "?workspaceId=other-ws");
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json()).error.code).toBe("TEAM_RUN_WORKSPACE_MISMATCH");
  });
});
