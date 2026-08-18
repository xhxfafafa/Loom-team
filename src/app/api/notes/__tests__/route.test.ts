import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createNote, type Note } from "@/core/models/note";
import { TaskStatus } from "@/core/models/task";

interface FakeSystem {
  noteStore: {
    get: (noteId: string, workspaceId: string) => Promise<Note | undefined>;
    listByWorkspace: (workspaceId: string) => Promise<Note[]>;
    listByType: (workspaceId: string, type: string) => Promise<Note[]>;
    save: (note: Note, source?: string) => Promise<void>;
    delete: (noteId: string, workspaceId: string) => Promise<void>;
  };
  noteBroadcaster: {
    notifyCreated: ReturnType<typeof vi.fn>;
    notifyUpdated: ReturnType<typeof vi.fn>;
    notifyDeleted: ReturnType<typeof vi.fn>;
  };
}

function createFakeSystem(): FakeSystem {
  const notes = new Map<string, Note>();
  const key = (noteId: string, workspaceId: string) => `${workspaceId}:${noteId}`;

  return {
    noteStore: {
      async get(noteId, workspaceId) {
        return notes.get(key(noteId, workspaceId));
      },
      async listByWorkspace(workspaceId) {
        return [...notes.values()].filter((note) => note.workspaceId === workspaceId);
      },
      async listByType(workspaceId, type) {
        return [...notes.values()].filter(
          (note) => note.workspaceId === workspaceId && note.metadata.type === type,
        );
      },
      async save(note) {
        notes.set(key(note.id, note.workspaceId), note);
      },
      async delete(noteId, workspaceId) {
        notes.delete(key(noteId, workspaceId));
      },
    },
    noteBroadcaster: {
      notifyCreated: vi.fn(),
      notifyUpdated: vi.fn(),
      notifyDeleted: vi.fn(),
    },
  };
}

let system: FakeSystem;

vi.mock("@/core/routa-system", () => ({
  getRoutaSystem: () => system,
}));

vi.mock("@/core/acp/http-session-store", () => ({
  getHttpSessionStore: () => ({
    hydrateFromDb: async () => {},
    listSessions: () => [],
  }),
}));

import { DELETE, GET, POST } from "../route";

function postNotes(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/notes", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("/api/notes route", () => {
  beforeEach(() => {
    system = createFakeSystem();
  });

  it("creates general report notes", async () => {
    const response = await postNotes({
      title: "P0-2 完成报告",
      content: "Contact form hardening completed.",
      workspaceId: "workspace-1",
      sessionId: "team-run-1",
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.note.metadata.type).toBe("general");
    expect(data.note.sessionId).toBe("team-run-1");
    expect(system.noteBroadcaster.notifyCreated).toHaveBeenCalledTimes(1);
  });

  it("rejects bare task notes with HTTP 400", async () => {
    const response = await postNotes({
      noteId: "task-report-1",
      title: "优化分析报告",
      workspaceId: "workspace-1",
      type: "task",
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("linkedTaskId");
    expect(data.error).toContain("general");
    expect(await system.noteStore.get("task-report-1", "workspace-1")).toBeUndefined();
    expect(system.noteBroadcaster.notifyCreated).not.toHaveBeenCalled();
  });

  it("rejects task notes whose only metadata is the type discriminator", async () => {
    const response = await postNotes({
      title: "Bare task note",
      workspaceId: "workspace-1",
      type: "task",
      metadata: { custom: { source: "agent" } },
    });

    expect(response.status).toBe(400);
  });

  it("accepts structured task notes carrying linkedTaskId", async () => {
    const response = await postNotes({
      noteId: "task-mirror-1",
      title: "Structured mirror",
      workspaceId: "workspace-1",
      type: "task",
      metadata: { linkedTaskId: "task-123", taskStatus: "PENDING" },
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.note.metadata).toMatchObject({
      type: "task",
      linkedTaskId: "task-123",
      taskStatus: "PENDING",
    });
  });

  it("accepts structured task notes carrying only taskStatus", async () => {
    const response = await postNotes({
      title: "Status-only mirror",
      workspaceId: "workspace-1",
      type: "task",
      metadata: { taskStatus: "IN_PROGRESS" },
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.note.metadata.taskStatus).toBe("IN_PROGRESS");
  });

  it("accepts structured task notes carrying assignedAgentIds", async () => {
    const response = await postNotes({
      title: "Assigned mirror",
      workspaceId: "workspace-1",
      type: "task",
      metadata: { assignedAgentIds: ["agent-1"] },
    });

    expect(response.status).toBe(201);
  });

  it("keeps existing malformed task notes readable and editable", async () => {
    // Seed a pre-existing bare task note (historical data).
    await system.noteStore.save(
      createNote({
        id: "legacy-bare-task",
        title: "Historical bare task note",
        workspaceId: "workspace-1",
        metadata: { type: "task" },
      }),
      "agent",
    );

    // Readable through GET.
    const readResponse = await GET(
      new NextRequest("http://localhost/api/notes?workspaceId=workspace-1&noteId=legacy-bare-task"),
    );
    expect(readResponse.status).toBe(200);
    const readData = await readResponse.json();
    expect(readData.note.metadata.type).toBe("task");

    // Editable through the update path (noteId found → update, no 400).
    const updateResponse = await postNotes({
      noteId: "legacy-bare-task",
      title: "Historical bare task note (edited)",
      content: "Updated body",
      workspaceId: "workspace-1",
    });
    expect(updateResponse.status).toBe(200);
    const updated = await system.noteStore.get("legacy-bare-task", "workspace-1");
    expect(updated?.title).toBe("Historical bare task note (edited)");
    expect(updated?.metadata.type).toBe("task");
  });

  it("preserves task metadata when updating an existing valid task note", async () => {
    await system.noteStore.save(
      createNote({
        id: "task-mirror-2",
        title: "Mirror",
        workspaceId: "workspace-1",
        metadata: { type: "task", linkedTaskId: "task-9", taskStatus: TaskStatus.PENDING },
      }),
      "agent",
    );

    const response = await postNotes({
      noteId: "task-mirror-2",
      content: "Progress update",
      workspaceId: "workspace-1",
    });

    expect(response.status).toBe(200);
    const stored = await system.noteStore.get("task-mirror-2", "workspace-1");
    expect(stored?.metadata.linkedTaskId).toBe("task-9");
    expect(stored?.content).toBe("Progress update");
  });

  it("returns created general reports in the workspace note listing", async () => {
    await postNotes({ title: "QA report", workspaceId: "workspace-1", sessionId: "team-run-1" });

    const response = await GET(
      new NextRequest("http://localhost/api/notes?workspaceId=workspace-1"),
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.notes).toHaveLength(1);
    expect(data.notes[0].title).toBe("QA report");
  });

  it("still rejects note creation without workspaceId", async () => {
    const response = await postNotes({ title: "No workspace" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "workspaceId is required" });
  });

  it("returns 404 when fetching an unknown note by id", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/notes?workspaceId=workspace-1&noteId=missing"),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Note not found" });
  });

  it("filters the note listing by sessionId", async () => {
    await postNotes({ noteId: "note-s1", title: "In session", workspaceId: "workspace-1", sessionId: "team-run-1" });
    await postNotes({ noteId: "note-s2", title: "Other session", workspaceId: "workspace-1", sessionId: "team-run-2" });

    const response = await GET(
      new NextRequest("http://localhost/api/notes?workspaceId=workspace-1&sessionId=team-run-1"),
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.notes).toHaveLength(1);
    expect(data.notes[0].title).toBe("In session");
  });

  it("deletes a note and broadcasts the deletion", async () => {
    await postNotes({ noteId: "note-del", title: "To delete", workspaceId: "workspace-1" });
    expect(await system.noteStore.get("note-del", "workspace-1")).toBeDefined();

    const response = await DELETE(
      new NextRequest("http://localhost/api/notes?noteId=note-del&workspaceId=workspace-1", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, noteId: "note-del" });
    expect(await system.noteStore.get("note-del", "workspace-1")).toBeUndefined();
    expect(system.noteBroadcaster.notifyDeleted).toHaveBeenCalledWith("note-del", "workspace-1", "user");
  });

  it("rejects deletion without noteId or workspaceId", async () => {
    const missingNoteId = await DELETE(
      new NextRequest("http://localhost/api/notes?workspaceId=workspace-1", { method: "DELETE" }),
    );
    expect(missingNoteId.status).toBe(400);

    const missingWorkspace = await DELETE(
      new NextRequest("http://localhost/api/notes?noteId=note-del", { method: "DELETE" }),
    );
    expect(missingWorkspace.status).toBe(400);
  });
});
