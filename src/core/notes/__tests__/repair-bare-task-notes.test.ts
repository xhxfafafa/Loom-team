import { describe, expect, it } from "vitest";

import { createNote } from "@/core/models/note";
import { TaskStatus } from "@/core/models/task";
import { InMemoryNoteStore } from "@/core/store/note-store";

import { isBareTaskNote, repairBareTaskNotes } from "../repair-bare-task-notes";

async function seedFixture(store: InMemoryNoteStore, workspaceId: string, sessionId?: string) {
  // Bare task note — eligible for reclassification.
  await store.save(
    createNote({
      id: "report-code-quality-architecture",
      title: "优化分析报告",
      workspaceId,
      sessionId,
      metadata: { type: "task" },
    }),
    "agent",
  );
  // Linked task note — must never be touched.
  await store.save(
    createNote({
      id: "task-mirror",
      title: "Structured mirror",
      workspaceId,
      sessionId,
      metadata: { type: "task", linkedTaskId: "task-1", taskStatus: TaskStatus.COMPLETED, parentNoteId: "spec" },
    }),
    "agent",
  );
  // Legacy task note with explicit status — must never be touched.
  await store.save(
    createNote({
      id: "legacy-status",
      title: "Legacy status note",
      workspaceId,
      sessionId,
      metadata: { type: "task", taskStatus: TaskStatus.IN_PROGRESS },
    }),
    "agent",
  );
  // General report note — already correctly classified.
  await store.save(
    createNote({
      id: "general-report",
      title: "QA report",
      workspaceId,
      sessionId,
      metadata: { type: "general" },
    }),
    "agent",
  );
}

describe("isBareTaskNote", () => {
  it("selects only task notes lacking every task-semantic field", () => {
    const bare = createNote({ id: "bare", title: "t", workspaceId: "ws", metadata: { type: "task" } });
    const linked = createNote({ id: "linked", title: "t", workspaceId: "ws", metadata: { type: "task", linkedTaskId: "task-1" } });
    const status = createNote({ id: "status", title: "t", workspaceId: "ws", metadata: { type: "task", taskStatus: TaskStatus.PENDING } });
    const parented = createNote({ id: "parented", title: "t", workspaceId: "ws", metadata: { type: "task", parentNoteId: "spec" } });
    const assigned = createNote({ id: "assigned", title: "t", workspaceId: "ws", metadata: { type: "task", assignedAgentIds: ["a-1"] } });
    const emptyAssigned = createNote({ id: "empty-assigned", title: "t", workspaceId: "ws", metadata: { type: "task", assignedAgentIds: [] } });
    const general = createNote({ id: "general", title: "t", workspaceId: "ws", metadata: { type: "general" } });

    expect(isBareTaskNote(bare)).toBe(true);
    expect(isBareTaskNote(emptyAssigned)).toBe(true);
    expect(isBareTaskNote(linked)).toBe(false);
    expect(isBareTaskNote(status)).toBe(false);
    expect(isBareTaskNote(parented)).toBe(false);
    expect(isBareTaskNote(assigned)).toBe(false);
    expect(isBareTaskNote(general)).toBe(false);
  });
});

describe("repairBareTaskNotes", () => {
  it("performs no writes in the default dry-run mode", async () => {
    const store = new InMemoryNoteStore();
    await seedFixture(store, "workspace-1", "team-run-1");

    const result = await repairBareTaskNotes(store, { workspaceId: "workspace-1" });

    expect(result.mode).toBe("dry-run");
    expect(result.candidates.map((candidate) => candidate.noteId)).toEqual([
      "report-code-quality-architecture",
    ]);
    expect(result.reclassified).toEqual([]);
    const untouched = await store.get("report-code-quality-architecture", "workspace-1");
    expect(untouched?.metadata.type).toBe("task");
  });

  it("prints note identity fields for review before any change", async () => {
    const store = new InMemoryNoteStore();
    await seedFixture(store, "workspace-1", "team-run-1");

    const result = await repairBareTaskNotes(store, { workspaceId: "workspace-1" });

    expect(result.candidates[0]).toEqual({
      noteId: "report-code-quality-architecture",
      title: "优化分析报告",
      workspaceId: "workspace-1",
      sessionId: "team-run-1",
    });
  });

  it("reclassifies only bare task notes and preserves everything else", async () => {
    const store = new InMemoryNoteStore();
    await seedFixture(store, "workspace-1", "team-run-1");
    const before = await store.get("report-code-quality-architecture", "workspace-1");

    const result = await repairBareTaskNotes(store, { workspaceId: "workspace-1", apply: true });

    expect(result.mode).toBe("apply");
    expect(result.reclassified).toEqual(["report-code-quality-architecture"]);

    const repaired = await store.get("report-code-quality-architecture", "workspace-1");
    expect(repaired?.metadata.type).toBe("general");
    // Content, ownership, and timestamps survive the reclassification.
    expect(repaired?.title).toBe(before?.title);
    expect(repaired?.content).toBe(before?.content);
    expect(repaired?.sessionId).toBe(before?.sessionId);
    expect(repaired?.workspaceId).toBe(before?.workspaceId);
    expect(repaired?.createdAt).toEqual(before?.createdAt);

    // Valid task notes remain untouched.
    expect((await store.get("task-mirror", "workspace-1"))?.metadata.type).toBe("task");
    expect((await store.get("task-mirror", "workspace-1"))?.metadata.linkedTaskId).toBe("task-1");
    expect((await store.get("legacy-status", "workspace-1"))?.metadata.type).toBe("task");
    expect((await store.get("general-report", "workspace-1"))?.metadata.type).toBe("general");
  });

  it("is idempotent across repeated apply runs", async () => {
    const store = new InMemoryNoteStore();
    await seedFixture(store, "workspace-1", "team-run-1");

    const first = await repairBareTaskNotes(store, { workspaceId: "workspace-1", apply: true });
    const second = await repairBareTaskNotes(store, { workspaceId: "workspace-1", apply: true });

    expect(first.reclassified).toHaveLength(1);
    expect(second.candidates).toEqual([]);
    expect(second.reclassified).toEqual([]);
  });

  it("enforces workspace scoping", async () => {
    const store = new InMemoryNoteStore();
    await seedFixture(store, "workspace-1", "team-run-1");
    await seedFixture(store, "workspace-2", "team-run-2");

    const result = await repairBareTaskNotes(store, { workspaceId: "workspace-1", apply: true });

    expect(result.reclassified).toEqual(["report-code-quality-architecture"]);
    // Other workspace keeps its bare task note.
    const other = await store.get("report-code-quality-architecture", "workspace-2");
    expect(other?.metadata.type).toBe("task");
  });

  it("enforces Team Run/session scoping", async () => {
    const store = new InMemoryNoteStore();
    await seedFixture(store, "workspace-1", "team-run-1");
    // Same workspace, different session.
    await store.save(
      createNote({
        id: "other-session-report",
        title: "Other session report",
        workspaceId: "workspace-1",
        sessionId: "team-run-9",
        metadata: { type: "task" },
      }),
      "agent",
    );

    const result = await repairBareTaskNotes(store, {
      workspaceId: "workspace-1",
      sessionId: "team-run-1",
      apply: true,
    });

    expect(result.reclassified).toEqual(["report-code-quality-architecture"]);
    const outsideScope = await store.get("other-session-report", "workspace-1");
    expect(outsideScope?.metadata.type).toBe("task");
  });
});
