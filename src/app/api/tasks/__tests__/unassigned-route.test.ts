import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, GET } from "../unassigned/route";

const { state } = vi.hoisted(() => ({
  state: {
    sessions: [] as Array<Record<string, unknown>>,
    tasks: [] as Array<Record<string, unknown>>,
    deletedTasks: [] as string[],
    notified: [] as string[],
  },
}));

vi.mock("@/core/db/index", () => ({
  getDatabaseDriver: () => "memory",
  getPostgresDatabase: () => {
    throw new Error("postgres driver is not used in these tests");
  },
}));

vi.mock("../unassigned-cards-ports", () => ({
  createUnassignedCardsPorts: () => ({
    listSessions: () => state.sessions,
    taskStore: {
      listByWorkspace: async (workspaceId: string) =>
        state.tasks.filter((task) => task.workspaceId === workspaceId),
      delete: async (id: string) => {
        state.deletedTasks.push(id);
      },
    },
    notifyTaskDeleted: (_workspaceId: string, taskId: string) => {
      state.notified.push(taskId);
    },
  }),
}));

beforeEach(() => {
  state.sessions = [
    {
      sessionId: "root-1",
      name: "Team - Alpha",
      specialistId: "team-agent-lead",
      workspaceId: "ws-1",
      parentSessionId: undefined,
    },
    {
      sessionId: "child-1",
      workspaceId: "ws-1",
      parentSessionId: "root-1",
    },
  ];
  state.tasks = [
    // Unassigned: no teamRunId, no team linkage.
    { id: "task-orphan", workspaceId: "ws-1" },
    // Explicitly owned by the team.
    { id: "task-owned", workspaceId: "ws-1", teamRunId: "root-1" },
    // Legacy-linked into the team tree.
    { id: "task-linked", workspaceId: "ws-1", triggerSessionId: "child-1" },
    // Another workspace entirely.
    { id: "task-other-ws", workspaceId: "ws-2" },
  ];
  state.deletedTasks = [];
  state.notified = [];
});

function callGet(search: string) {
  return GET(new NextRequest(`http://localhost/api/tasks/unassigned${search}`));
}

function callDelete(search: string, body?: unknown) {
  const init: { method: string; body?: string; headers?: Record<string, string> } = {
    method: "DELETE",
  };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  return DELETE(new NextRequest(`http://localhost/api/tasks/unassigned${search}`, init));
}

describe("GET /api/tasks/unassigned", () => {
  it("requires a workspace", async () => {
    const response = await callGet("");
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("WORKSPACE_ID_REQUIRED");
  });

  it("returns the unassigned card count and IDs without mutating anything", async () => {
    const response = await callGet("?workspaceId=ws-1");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.workspaceId).toBe("ws-1");
    expect(body.count).toBe(1);
    expect(body.taskIds).toEqual(["task-orphan"]);
    expect(state.deletedTasks).toEqual([]);
  });
});

describe("DELETE /api/tasks/unassigned", () => {
  it("requires the DELETE confirmation token in the body", async () => {
    const noBody = await callDelete("?workspaceId=ws-1");
    expect(noBody.status).toBe(400);
    expect((await noBody.json()).error.code).toBe("CONFIRMATION_REQUIRED");

    const wrongToken = await callDelete("?workspaceId=ws-1", { confirm: "yes" });
    expect(wrongToken.status).toBe(400);
    expect((await wrongToken.json()).error.code).toBe("CONFIRMATION_REQUIRED");

    const malformed = await callDelete("?workspaceId=ws-1", "{not-json");
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("CONFIRMATION_REQUIRED");

    expect(state.deletedTasks).toEqual([]);
  });

  it("requires a workspace", async () => {
    const response = await callDelete("", { confirm: "DELETE" });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("WORKSPACE_ID_REQUIRED");
    expect(state.deletedTasks).toEqual([]);
  });

  it("deletes only unassigned cards in the workspace after confirmation", async () => {
    const response = await callDelete("?workspaceId=ws-1", { confirm: "DELETE" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.workspaceId).toBe("ws-1");
    expect(body.deletedCount).toBe(1);
    expect(body.deletedTaskIds).toEqual(["task-orphan"]);
    expect(state.deletedTasks).toEqual(["task-orphan"]);
    expect(state.notified).toEqual(["task-orphan"]);
    // Owned, team-linked and cross-workspace cards are never touched.
    expect(state.deletedTasks).not.toContain("task-owned");
    expect(state.deletedTasks).not.toContain("task-linked");
    expect(state.deletedTasks).not.toContain("task-other-ws");
  });

  it("returns zero deletions when nothing is unassigned", async () => {
    state.tasks = [{ id: "task-owned", workspaceId: "ws-1", teamRunId: "root-1" }];

    const response = await callDelete("?workspaceId=ws-1", { confirm: "DELETE" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deletedCount).toBe(0);
    expect(body.deletedTaskIds).toEqual([]);
    expect(state.deletedTasks).toEqual([]);
  });
});
