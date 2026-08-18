import { describe, expect, it } from "vitest";

import type { NoteData } from "@/client/hooks/use-notes";

import {
  buildTeamTaskTree,
  extractDelegationResult,
  extractDelegationSessionId,
  isLegacyTaskNote,
  normalizeTaskStatus,
  resolveDelegationRosterSpecialistId,
  resolveDelegationTarget,
  resolveRosterSpecialistId,
  resolveSessionRuntimeStatus,
  resolveTeamPromptErrorI18nKey,
  type PersistedTeamTask,
} from "../team-run-page-model";

function makeNote(overrides: Partial<NoteData> & Pick<NoteData, "id" | "title">): NoteData {
  return {
    content: "",
    workspaceId: "default",
    metadata: { type: "task" },
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

function makeTask(overrides: Partial<PersistedTeamTask> & Pick<PersistedTeamTask, "id" | "title">): PersistedTeamTask {
  return {
    status: "IN_PROGRESS",
    sessionIds: [],
    ...overrides,
  };
}

describe("team-run-page-model", () => {
  it("extracts delegated child session id from tool output", () => {
    expect(extractDelegationSessionId({
      rawOutput: {
        output: "{\"success\":true,\"sessionId\":\"child-123\",\"agentId\":\"agent-1\"}",
      },
    })).toBe("child-123");
  });

  describe("normalizeTaskStatus", () => {
    it("recognizes delegated as in-progress", () => {
      expect(normalizeTaskStatus("delegated")).toBe("in-progress");
      expect(normalizeTaskStatus("DELEGATED")).toBe("in-progress");
    });

    it("keeps the existing lifecycle mappings", () => {
      expect(normalizeTaskStatus("COMPLETED")).toBe("done");
      expect(normalizeTaskStatus("IN_PROGRESS")).toBe("in-progress");
      expect(normalizeTaskStatus("REVIEW_REQUIRED")).toBe("waiting-review");
      expect(normalizeTaskStatus("NEEDS_FIX")).toBe("blocked");
      expect(normalizeTaskStatus(undefined)).toBe("not-started");
    });
  });

  describe("extractDelegationResult", () => {
    it("prefers structured fields on the raw output object", () => {
      expect(extractDelegationResult({
        rawOutput: {
          sessionId: "child-1",
          delegatedTaskId: "task-1",
          status: "delegated",
          output: "{\"sessionId\":\"should-not-win\"}",
        },
      })).toEqual({ sessionId: "child-1", delegatedTaskId: "task-1", status: "delegated" });
    });

    it("unwraps MCP-style content wrappers", () => {
      expect(extractDelegationResult({
        rawOutput: {
          content: [
            { type: "text", text: "{\"taskId\":\"task-7\",\"sessionId\":\"child-7\",\"status\":\"delegated\"}" },
          ],
        },
      })).toEqual({ sessionId: "child-7", delegatedTaskId: "task-7", status: "delegated" });
    });

    it("falls back to regex inference for malformed output", () => {
      expect(extractDelegationResult({
        rawOutput: { output: "prefix \"sessionId\": \"child-5\" trailing {broken json" },
      }).sessionId).toBe("child-5");
    });

    it("uses persisted tasks as primary nodes with their session history", () => {
      const tree = buildTeamTaskTree([
        makeTask({ id: "task-1", title: "Implement API", status: "DELEGATED", sessionIds: ["child-1"] }),
      ], []);

      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({
        id: "task-task-1",
        title: "Implement API",
        status: "in-progress",
        linkedTaskId: "task-1",
        sessionIds: ["child-1"],
        children: [],
      });
    });

    it("dedupes task notes whose linkedTaskId matches a persisted task", () => {
      const tree = buildTeamTaskTree(
        [makeTask({ id: "task-1", title: "Persisted card" })],
        [
          makeNote({ id: "note-1", title: "Linked note", metadata: { type: "task", linkedTaskId: "task-1" } }),
          makeNote({ id: "note-2", title: "Legacy note", metadata: { type: "task", taskStatus: "COMPLETED" } }),
        ],
      );

      expect(tree.map((node) => node.title)).toEqual(["Persisted card", "Legacy note"]);
      const legacy = tree[1];
      expect(legacy?.legacy).toBe(true);
      expect(legacy?.status).toBe("done");
      expect(tree[0]?.legacy).toBeUndefined();
    });

    it("keeps unmatched task notes as read-only legacy nodes with hierarchy", () => {
      const tree = buildTeamTaskTree([], [
        makeNote({ id: "root", title: "Plan", metadata: { type: "task", taskStatus: "PENDING" } }),
        makeNote({ id: "child", title: "Subtask", metadata: { type: "task", parentNoteId: "root" } }),
        makeNote({ id: "spec", title: "Spec note", metadata: { type: "spec" } }),
      ]);

      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ id: "root", title: "Plan", legacy: true });
      expect(tree[0]?.children).toHaveLength(1);
      expect(tree[0]?.children[0]).toMatchObject({ id: "child", title: "Subtask", legacy: true });
    });

    it("promotes children of deduped notes to roots instead of dropping them", () => {
      const tree = buildTeamTaskTree(
        [makeTask({ id: "task-1", title: "Persisted card" })],
        [
          makeNote({ id: "note-1", title: "Linked note", metadata: { type: "task", linkedTaskId: "task-1" } }),
          makeNote({ id: "note-2", title: "Orphaned child", metadata: { type: "task", parentNoteId: "note-1" } }),
        ],
      );

      expect(tree.map((node) => node.title)).toEqual(["Persisted card", "Orphaned child"]);
    });
  });

  // ── Report-Note classification regression ────────────────────────────────
  // Confirmed failure (issue 2026-08-18): completion-report Notes whose only
  // metadata was `{ type: "task" }` rendered as extra NOT STARTED rows next to
  // the already-COMPLETED persisted Tasks.
  describe("buildTeamTaskTree report-note classification", () => {
    it("renders a COMPLETED task exactly once as done when bare task report notes exist", () => {
      const tree = buildTeamTaskTree(
        [
          makeTask({ id: "task-a", title: "P0-1 dependency security", status: "COMPLETED" }),
          makeTask({ id: "task-b", title: "P0-2 contact form", status: "COMPLETED" }),
        ],
        [
          makeNote({
            id: "report-code-quality-architecture",
            title: "优化分析报告",
            metadata: { type: "task" },
          }),
          makeNote({
            id: "task-p0-1-dep-security-report",
            title: "P0-1 完成报告",
            metadata: { type: "task" },
          }),
          makeNote({
            id: "task-p0-2-contact-form-report",
            title: "P0-2 完成报告",
            metadata: { type: "task" },
          }),
        ],
      );

      expect(tree).toHaveLength(2);
      expect(tree.map((node) => node.title)).toEqual([
        "P0-1 dependency security",
        "P0-2 contact form",
      ]);
      for (const node of tree) {
        expect(node.status).toBe("done");
        expect(node.legacy).toBeUndefined();
      }
    });

    it("excludes bare task-typed notes from the task tree", () => {
      const tree = buildTeamTaskTree([], [
        makeNote({ id: "bare-report", title: "Completion report", metadata: { type: "task" } }),
      ]);

      expect(tree).toEqual([]);
    });

    it("does not mutate notes so the deliverables projection keeps every report", () => {
      const notes = [
        makeNote({ id: "bare-report", title: "Completion report", metadata: { type: "task" } }),
        makeNote({ id: "general-note", title: "Research", metadata: { type: "general" } }),
      ];

      buildTeamTaskTree([], notes);

      // Deliverables read the raw notes list; classification must only filter
      // the task-tree projection, never rewrite or drop source notes.
      expect(notes).toHaveLength(2);
      expect(notes[0]?.metadata).toEqual({ type: "task" });
      expect(notes[1]?.metadata).toEqual({ type: "general" });
    });

    it("dedupes linked task notes against loaded persisted tasks", () => {
      const tree = buildTeamTaskTree(
        [makeTask({ id: "task-1", title: "Persisted card", status: "COMPLETED" })],
        [
          makeNote({
            id: "note-1",
            title: "Linked mirror",
            metadata: { type: "task", linkedTaskId: "task-1", taskStatus: "COMPLETED" },
          }),
        ],
      );

      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ linkedTaskId: "task-1", status: "done" });
      expect(tree[0]?.legacy).toBeUndefined();
    });

    it("renders a note linked to a missing historical task as legacy", () => {
      const tree = buildTeamTaskTree([], [
        makeNote({
          id: "note-old",
          title: "Historical mirror",
          metadata: { type: "task", linkedTaskId: "task-gone", taskStatus: "IN_PROGRESS" },
        }),
      ]);

      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ id: "note-old", legacy: true, status: "in-progress" });
    });

    it("renders an unlinked note with explicit taskStatus as legacy not-started", () => {
      const tree = buildTeamTaskTree([], [
        makeNote({ id: "note-pending", title: "Pending", metadata: { type: "task", taskStatus: "PENDING" } }),
      ]);

      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ legacy: true, status: "not-started" });
    });

    it("keeps unlinked notes with parentNoteId or assignment metadata eligible", () => {
      const tree = buildTeamTaskTree([], [
        makeNote({ id: "note-parented", title: "Child", metadata: { type: "task", parentNoteId: "somewhere-else" } }),
        makeNote({ id: "note-assigned", title: "Assigned", metadata: { type: "task", assignedAgentIds: ["agent-1"] } }),
        makeNote({ id: "note-empty-assign", title: "Empty assignment", metadata: { type: "task", assignedAgentIds: [] } }),
      ]);

      expect(tree.map((node) => node.id)).toEqual(["note-parented", "note-assigned"]);
    });
  });

  describe("isLegacyTaskNote", () => {
    it("accepts task notes with at least one explicit task-semantic field", () => {
      expect(isLegacyTaskNote(makeNote({ id: "n1", title: "t", metadata: { type: "task", linkedTaskId: "task-1" } }))).toBe(true);
      expect(isLegacyTaskNote(makeNote({ id: "n2", title: "t", metadata: { type: "task", taskStatus: "PENDING" } }))).toBe(true);
      expect(isLegacyTaskNote(makeNote({ id: "n3", title: "t", metadata: { type: "task", parentNoteId: "spec" } }))).toBe(true);
      expect(isLegacyTaskNote(makeNote({ id: "n4", title: "t", metadata: { type: "task", assignedAgentIds: ["agent-1"] } }))).toBe(true);
    });

    it("rejects bare task notes and non-task notes", () => {
      expect(isLegacyTaskNote(makeNote({ id: "n5", title: "t", metadata: { type: "task" } }))).toBe(false);
      expect(isLegacyTaskNote(makeNote({ id: "n6", title: "t", metadata: { type: "task", assignedAgentIds: [] } }))).toBe(false);
      expect(isLegacyTaskNote(makeNote({ id: "n7", title: "t", metadata: { type: "general", taskStatus: "PENDING" } }))).toBe(false);
      expect(isLegacyTaskNote(makeNote({ id: "n8", title: "t", metadata: { type: "spec" } }))).toBe(false);
    });

    it("does not inspect note id, title, or content", () => {
      // Report-looking ids/titles/content must not qualify a bare note.
      expect(isLegacyTaskNote(makeNote({
        id: "task-p0-1-dep-security-report",
        title: "P0-1 完成报告",
        content: "task taskStatus linkedTaskId parentNoteId assignedAgentIds",
        metadata: { type: "task" },
      }))).toBe(false);
      // Conversely, a neutral title with real semantics still qualifies.
      expect(isLegacyTaskNote(makeNote({
        id: "note-plain",
        title: "Untitled",
        metadata: { type: "task", taskStatus: "COMPLETED" },
      }))).toBe(true);
    });
  });

  it("falls back to delegated roster mapping for child sessions without specialist ids", () => {
    const delegatedRosterIdsBySessionId = new Map([
      ["child-123", "team-backend-dev"],
    ]);

    expect(resolveRosterSpecialistId({
      sessionId: "child-123",
      cwd: "/tmp",
      workspaceId: "default",
      createdAt: "2026-03-23T00:00:00.000Z",
      role: "CRAFTER",
    }, undefined, delegatedRosterIdsBySessionId)).toBe("team-backend-dev");
  });

  it("maps specialist aliases from delegation tool calls to team roster roles", () => {
    expect(resolveDelegationRosterSpecialistId({
      rawInput: {
        specialist: "researcher",
      },
    })).toBe("team-researcher");

    expect(resolveDelegationRosterSpecialistId({
      rawInput: {
        specialist: "backend-dev",
      },
    })).toBe("team-backend-dev");

    expect(resolveDelegationRosterSpecialistId({
      rawInput: {
        specialist: "qa",
      },
    })).toBe("team-qa");
  });

  it("renders human labels for delegation aliases", () => {
    expect(resolveDelegationTarget({
      rawInput: {
        specialist: "researcher",
      },
    })).toBe("Research Analyst");

    expect(resolveDelegationTarget({
      rawInput: {
        specialist: "backend-dev",
      },
    })).toBe("Backend Developer");
  });

  describe("resolveSessionRuntimeStatus", () => {
    it("reports working only when the runtime continuity is active", () => {
      expect(resolveSessionRuntimeStatus({
        acpStatus: "ready",
        continuityStatus: "active",
      })).toBe("working");
    });

    it("does not report a persisted ready status as working without an active runtime", () => {
      // Regression: the Team Lead used to be hard-coded as "working" whenever
      // it was not in an error state, even after the provider process exited.
      expect(resolveSessionRuntimeStatus({
        acpStatus: "ready",
        continuityStatus: "restorable",
      })).toBe("suspended");
      expect(resolveSessionRuntimeStatus({
        acpStatus: undefined,
        continuityStatus: "restorable",
      })).toBe("suspended");
    });

    it("labels recovery-in-progress and failed runtimes distinctly", () => {
      expect(resolveSessionRuntimeStatus({
        acpStatus: "connecting",
        continuityStatus: "restorable",
      })).toBe("recovering");
      expect(resolveSessionRuntimeStatus({
        acpStatus: "error",
        continuityStatus: "interrupted",
      })).toBe("failed");
    });

    it("treats interrupted and stale sessions without an error as suspended", () => {
      expect(resolveSessionRuntimeStatus({
        acpStatus: undefined,
        continuityStatus: "interrupted",
      })).toBe("suspended");
      expect(resolveSessionRuntimeStatus({
        acpStatus: undefined,
        continuityStatus: "stale",
      })).toBe("suspended");
    });
  });

  // ── P1-2: structured recovery errors map to understandable i18n keys ────
  // The Team composer must show a localized, actionable message for recovery
  // failures (never a silently degraded chat), keyed off the structured
  // JSON-RPC `data.reason`/`data.failure` — not the raw English message.
  describe("resolveTeamPromptErrorI18nKey", () => {
    it("maps each structured recovery failure to a team i18n key", () => {
      expect(resolveTeamPromptErrorI18nKey({
        code: -32010,
        data: { reason: "runtime_owned", retryable: true },
      })).toBe("promptErrorRuntimeOwned");

      expect(resolveTeamPromptErrorI18nKey({
        code: -32011,
        data: { reason: "recovery_unavailable", retryable: true },
      })).toBe("promptErrorRecoveryUnavailable");

      expect(resolveTeamPromptErrorI18nKey({
        code: -32004,
        data: { reason: "session_not_found", retryable: false },
      })).toBe("promptErrorSessionNotFound");

      expect(resolveTeamPromptErrorI18nKey({
        code: -32012,
        data: { reason: "recovery_failed", failure: "missing_team_metadata", retryable: false },
      })).toBe("promptErrorMissingTeamMetadata");

      expect(resolveTeamPromptErrorI18nKey({
        code: -32012,
        data: { reason: "recovery_failed", failure: "team_bindings_incomplete", retryable: true },
      })).toBe("promptErrorTeamBindingsIncomplete");
    });

    it("returns null for errors without a structured recovery reason", () => {
      expect(resolveTeamPromptErrorI18nKey(new Error("boom"))).toBeNull();
      expect(resolveTeamPromptErrorI18nKey(undefined)).toBeNull();
      expect(resolveTeamPromptErrorI18nKey({ code: -32000, message: "generic" })).toBeNull();
      // recovery_failed without a `failure` discriminator is a generic
      // recovery error; it falls back to the raw message, not a team key.
      expect(resolveTeamPromptErrorI18nKey({
        code: -32012,
        data: { reason: "recovery_failed" },
      })).toBeNull();
    });
  });
});
