import { describe, expect, it } from "vitest";

import { TaskStatus } from "@/core/models/task";
import { InMemoryNoteStore } from "@/core/store/note-store";
import { InMemoryTaskStore } from "@/core/store/task-store";

import { NoteTools } from "../note-tools";

function createNoteTools() {
  const noteStore = new InMemoryNoteStore();
  const taskStore = new InMemoryTaskStore();
  const tools = new NoteTools(noteStore, taskStore);
  return { noteStore, taskStore, tools };
}

describe("NoteTools.createNote classification boundary", () => {
  it("defaults to general when no type is provided", async () => {
    const { noteStore, tools } = createNoteTools();

    const result = await tools.createNote({
      title: "Completion report",
      content: "All acceptance criteria verified.",
      workspaceId: "workspace-1",
    });

    expect(result.success).toBe(true);
    const noteId = (result.data as { noteId: string }).noteId;
    const stored = await noteStore.get(noteId, "workspace-1");
    expect(stored?.metadata.type).toBe("general");
  });

  it("creates completion reports as general notes", async () => {
    const { noteStore, tools } = createNoteTools();

    const result = await tools.createNote({
      title: "P0-1 完成报告",
      content: "Dependency security upgrade completed.",
      workspaceId: "workspace-1",
      type: "general",
      sessionId: "team-run-1",
    });

    expect(result.success).toBe(true);
    const noteId = (result.data as { noteId: string }).noteId;
    const stored = await noteStore.get(noteId, "workspace-1");
    expect(stored?.metadata.type).toBe("general");
    expect(stored?.sessionId).toBe("team-run-1");
  });

  it("rejects generic task note creation with actionable guidance", async () => {
    const { noteStore, tools } = createNoteTools();

    const result = await tools.createNote({
      title: "P0 verification report",
      content: "Report body",
      workspaceId: "workspace-1",
      type: "task",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("general");
    expect(result.error).toContain("create_task");
    expect(result.error).toContain("convert_task_blocks");

    // Nothing may be persisted through the rejected path.
    const notes = await noteStore.listByWorkspace("workspace-1");
    expect(notes).toEqual([]);
  });

  it("still allows spec note creation", async () => {
    const { noteStore, tools } = createNoteTools();

    const result = await tools.createNote({
      title: "Spec",
      workspaceId: "workspace-1",
      type: "spec",
      noteId: "spec-draft",
    });

    expect(result.success).toBe(true);
    const stored = await noteStore.get("spec-draft", "workspace-1");
    expect(stored?.metadata.type).toBe("spec");
  });
});

describe("NoteTools.convertTaskBlocks structured path", () => {
  it("still creates persisted tasks plus linked task notes with full task metadata", async () => {
    const { noteStore, taskStore, tools } = createNoteTools();

    const spec = await noteStore.ensureSpec("workspace-1");
    spec.content = [
      "Plan with one task block.",
      "@@@task",
      "# Harden dependency security",
      "## Objective",
      "Upgrade vulnerable dependencies.",
      "## Definition of Done",
      "- Audit passes",
      "@@@",
    ].join("\n");
    await noteStore.save(spec, "user");

    const result = await tools.convertTaskBlocks({
      noteId: spec.id,
      workspaceId: "workspace-1",
      sessionId: "team-run-1",
      teamRunId: "team-run-1",
    });

    expect(result.success).toBe(true);
    const data = result.data as { blocksConverted: number; tasks: Array<{ taskId: string; noteId: string }> };
    expect(data.blocksConverted).toBe(1);
    const [{ taskId, noteId }] = data.tasks;

    // Canonical persisted Task exists.
    const task = await taskStore.get(taskId);
    expect(task?.title).toBe("Harden dependency security");

    // Compatibility task Note carries every task-semantic field.
    const note = await noteStore.get(noteId, "workspace-1");
    expect(note?.metadata.type).toBe("task");
    expect(note?.metadata.linkedTaskId).toBe(taskId);
    expect(note?.metadata.taskStatus).toBe(TaskStatus.PENDING);
    expect(note?.metadata.parentNoteId).toBe(spec.id);
    expect(note?.sessionId).toBe("team-run-1");
  });
});
