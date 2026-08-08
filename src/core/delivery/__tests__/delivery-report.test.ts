import { describe, expect, it, vi } from "vitest";
import { buildDeliveryReport } from "../delivery-report";
import { createTask, TaskStatus, VerificationVerdict } from "../../models/task";
import type { Task } from "../../models/task";
import type { TaskStore } from "../../store/task-store";
import type { ArtifactStore } from "../../store/artifact-store";
import type { CodebaseStore } from "../../db/pg-codebase-store";
import type { Artifact } from "../../models/artifact";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeTask(id: string, overrides?: Partial<Task>): Task {
  const task = createTask({
    id,
    title: `Task ${id}`,
    objective: `Objective ${id}`,
    workspaceId: "ws-1",
    status: overrides?.status,
    comment: overrides?.comment,
    verificationCommands: overrides?.verificationCommands,
  });
  // Apply fields not supported by createTask params
  if (overrides) {
    if (overrides.verificationVerdict !== undefined) task.verificationVerdict = overrides.verificationVerdict;
    if (overrides.verificationReport !== undefined) task.verificationReport = overrides.verificationReport;
    if (overrides.completionSummary !== undefined) task.completionSummary = overrides.completionSummary;
    if (overrides.laneSessions !== undefined) task.laneSessions = overrides.laneSessions;
    if (overrides.deliverySnapshot !== undefined) task.deliverySnapshot = overrides.deliverySnapshot;
    if (overrides.jitContextSnapshot !== undefined) task.jitContextSnapshot = overrides.jitContextSnapshot;
  }
  return task;
}

function makeFakeTaskStore(tasks: Task[]): TaskStore {
  return {
    save: vi.fn(),
    get: vi.fn(async (id: string) => tasks.find((t) => t.id === id)),
    listByWorkspace: vi.fn(async () => tasks),
    listByStatus: vi.fn(async () => []),
    listByAssignee: vi.fn(async () => []),
    findReadyTasks: vi.fn(async () => []),
    updateStatus: vi.fn(),
    delete: vi.fn(),
    deleteByWorkspace: vi.fn(async () => 0),
  };
}

function makeFakeArtifactStore(artifactsByTask: Record<string, Artifact[]>): ArtifactStore {
  return {
    saveArtifact: vi.fn(),
    getArtifact: vi.fn(),
    listByTask: vi.fn(async (taskId: string) => artifactsByTask[taskId] ?? []),
    listByWorkspace: vi.fn(async () => Object.values(artifactsByTask).flat()),
    listByTaskAndType: vi.fn(async () => []),
    listByProvider: vi.fn(async () => []),
    deleteArtifact: vi.fn(),
    deleteByTask: vi.fn(),
    saveRequest: vi.fn(),
    getRequest: vi.fn(),
    listPendingRequests: vi.fn(async () => []),
    listRequestsByTask: vi.fn(async () => []),
    updateRequestStatus: vi.fn(),
  };
}

function makeFakeCodebaseStore(): CodebaseStore {
  return {
    add: vi.fn(),
    get: vi.fn(),
    listByWorkspace: vi.fn(async () => []),
    update: vi.fn(),
    remove: vi.fn(),
    getDefault: vi.fn(async () => undefined),
    setDefault: vi.fn(),
    countByWorkspace: vi.fn(async () => 0),
    findByRepoPath: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildDeliveryReport", () => {
  it("returns empty report when no tasks exist", async () => {
    const report = await buildDeliveryReport({
      workspaceId: "ws-1",
      taskStore: makeFakeTaskStore([]),
      artifactStore: makeFakeArtifactStore({}),
      codebaseStore: makeFakeCodebaseStore(),
    });

    expect(report.workspaceId).toBe("ws-1");
    expect(report.progress.total).toBe(0);
    expect(report.progress.done).toBe(0);
    expect(report.completed).toEqual([]);
    expect(report.outstanding).toEqual([]);
    expect(report.risks).toEqual([]);
    expect(report.howToRun).toEqual([]);
    expect(report.audit.traceCount).toBe(0);
    expect(report.audit.recentRuns).toEqual([]);
  });

  it("computes progress counts correctly", async () => {
    const tasks = [
      makeTask("t1", { status: TaskStatus.COMPLETED }),
      makeTask("t2", { status: TaskStatus.COMPLETED }),
      makeTask("t3", { status: TaskStatus.IN_PROGRESS }),
      makeTask("t4", { status: TaskStatus.REVIEW_REQUIRED }),
      makeTask("t5", { status: TaskStatus.BLOCKED }),
      makeTask("t6", { status: TaskStatus.PENDING }),
    ];

    const report = await buildDeliveryReport({
      workspaceId: "ws-1",
      taskStore: makeFakeTaskStore(tasks),
      artifactStore: makeFakeArtifactStore({}),
      codebaseStore: makeFakeCodebaseStore(),
    });

    expect(report.progress.total).toBe(6);
    expect(report.progress.done).toBe(2);
    expect(report.progress.inProgress).toBe(1);
    expect(report.progress.review).toBe(1);
    expect(report.progress.blocked).toBe(1);
  });

  it("includes completed tasks with evidence", async () => {
    const tasks = [
      makeTask("t1", {
        status: TaskStatus.COMPLETED,
        verificationVerdict: VerificationVerdict.APPROVED,
        completionSummary: "All tests passed",
      }),
    ];

    const artifact: Artifact = {
      id: "a1",
      type: "test_results",
      taskId: "t1",
      workspaceId: "ws-1",
      status: "provided",
      context: "All 42 tests passed",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const report = await buildDeliveryReport({
      workspaceId: "ws-1",
      taskStore: makeFakeTaskStore(tasks),
      artifactStore: makeFakeArtifactStore({ t1: [artifact] }),
      codebaseStore: makeFakeCodebaseStore(),
    });

    expect(report.completed).toHaveLength(1);
    expect(report.completed[0].taskId).toBe("t1");
    expect(report.completed[0].verificationVerdict).toBe("APPROVED");
    expect(report.completed[0].evidence.length).toBeGreaterThanOrEqual(2);
    // Has completion summary evidence
    expect(report.completed[0].evidence.some((e) => e.type === "completion_summary")).toBe(true);
    // Has artifact evidence
    expect(report.completed[0].evidence.some((e) => e.type === "artifact:test_results")).toBe(true);
  });

  it("lists outstanding tasks with blocker for blocked status", async () => {
    const tasks = [
      makeTask("t1", { status: TaskStatus.BLOCKED, comment: "Waiting for API key" }),
      makeTask("t2", { status: TaskStatus.IN_PROGRESS }),
    ];

    const report = await buildDeliveryReport({
      workspaceId: "ws-1",
      taskStore: makeFakeTaskStore(tasks),
      artifactStore: makeFakeArtifactStore({}),
      codebaseStore: makeFakeCodebaseStore(),
    });

    expect(report.outstanding).toHaveLength(2);
    const blocked = report.outstanding.find((t) => t.taskId === "t1");
    expect(blocked?.blocker).toBe("Waiting for API key");
    const inProgress = report.outstanding.find((t) => t.taskId === "t2");
    expect(inProgress?.blocker).toBeUndefined();
  });

  it("generates risks from blocked tasks and failed sessions", async () => {
    const tasks = [
      makeTask("t1", {
        status: TaskStatus.BLOCKED,
        comment: "Dependency missing",
      }),
      makeTask("t2", {
        status: TaskStatus.IN_PROGRESS,
        laneSessions: [
          {
            sessionId: "s1",
            status: "failed",
            startedAt: "2026-01-01T00:00:00Z",
          },
          {
            sessionId: "s2",
            status: "timed_out",
            startedAt: "2026-01-01T01:00:00Z",
          },
        ],
      }),
    ];

    const report = await buildDeliveryReport({
      workspaceId: "ws-1",
      taskStore: makeFakeTaskStore(tasks),
      artifactStore: makeFakeArtifactStore({}),
      codebaseStore: makeFakeCodebaseStore(),
    });

    expect(report.risks.length).toBeGreaterThanOrEqual(2);
    // Blocked task risk
    expect(report.risks.some((r) => r.description.includes("blocked"))).toBe(true);
    // Failed sessions risk
    expect(report.risks.some((r) => r.description.includes("failed/timed-out"))).toBe(true);
  });

  it("deduplicates verification commands in howToRun", async () => {
    const tasks = [
      makeTask("t1", { verificationCommands: ["npm test", "npm run lint"] }),
      makeTask("t2", { verificationCommands: ["npm test", "npx tsc --noEmit"] }),
    ];

    const report = await buildDeliveryReport({
      workspaceId: "ws-1",
      taskStore: makeFakeTaskStore(tasks),
      artifactStore: makeFakeArtifactStore({}),
      codebaseStore: makeFakeCodebaseStore(),
    });

    expect(report.howToRun).toHaveLength(3);
    const commands = report.howToRun.map((h) => h.command);
    expect(commands).toContain("npm test");
    expect(commands).toContain("npm run lint");
    expect(commands).toContain("npx tsc --noEmit");
  });

  it("does not throw when taskStore fails", async () => {
    const failingStore = {
      save: vi.fn(),
      get: vi.fn(),
      listByWorkspace: vi.fn(async () => { throw new Error("DB error"); }),
      listByStatus: vi.fn(),
      listByAssignee: vi.fn(),
      findReadyTasks: vi.fn(),
      updateStatus: vi.fn(),
      delete: vi.fn(),
      deleteByWorkspace: vi.fn(),
    } as unknown as TaskStore;

    const report = await buildDeliveryReport({
      workspaceId: "ws-1",
      taskStore: failingStore,
      artifactStore: makeFakeArtifactStore({}),
      codebaseStore: makeFakeCodebaseStore(),
    });

    expect(report.progress.total).toBe(0);
    expect(report.completed).toEqual([]);
    expect(report.outstanding).toEqual([]);
  });

  it("does not throw when artifactStore fails", async () => {
    const tasks = [makeTask("t1", { status: TaskStatus.COMPLETED })];
    const failingArtifactStore = {
      saveArtifact: vi.fn(),
      getArtifact: vi.fn(),
      listByTask: vi.fn(async () => { throw new Error("store down"); }),
      listByWorkspace: vi.fn(),
      listByTaskAndType: vi.fn(),
      listByProvider: vi.fn(),
      deleteArtifact: vi.fn(),
      deleteByTask: vi.fn(),
      saveRequest: vi.fn(),
      getRequest: vi.fn(),
      listPendingRequests: vi.fn(),
      listRequestsByTask: vi.fn(),
      updateRequestStatus: vi.fn(),
    } as unknown as ArtifactStore;

    const report = await buildDeliveryReport({
      workspaceId: "ws-1",
      taskStore: makeFakeTaskStore(tasks),
      artifactStore: failingArtifactStore,
      codebaseStore: makeFakeCodebaseStore(),
    });

    expect(report.completed).toHaveLength(1);
    expect(report.completed[0].evidence).toEqual([]);
  });
});
