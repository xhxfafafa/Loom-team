import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTask, TaskStatus, type Task } from "@/core/models/task";
import type { TaskDeliveryReadiness } from "@/core/kanban/task-delivery-readiness";

/**
 * Task state-machine characterization for PATCH /api/tasks/[taskId].
 *
 * The Web backend deliberately has NO illegal-transition table: any
 * TaskStatus enum value can be written directly from any state. The guards
 * that DO exist and are pinned here:
 *
 * 1. enum membership — unknown statuses/priorities are rejected with 400;
 * 2. exact-case parsing on PATCH (no client-side normalization; the
 *    dedicated POST /status sub-route normalizes case, PATCH does not);
 * 3. status/columnId consistency — a combined write must describe one
 *    workflow state (literal mapping or a board column whose semantic stage
 *    matches);
 * 4. terminal writes resolve the board's done/blocked-stage column in one
 *    write instead of emitting phantom column ids.
 *
 * This is the accepted Web behavioral difference versus a Rust-side
 * transition-order table; per the Web-only migration doc (§15) the existing
 * guards are pinned as-is instead of inventing new transition rules.
 */

const notify = vi.fn();
const removeCardJob = vi.fn();
const enqueueKanbanTaskSession = vi.fn();
const processKanbanColumnTransition = vi.fn();
const createWorktree = vi.fn();
const buildTaskDeliveryReadiness = vi.fn<
  (task: Task, currentSystem: typeof system) => Promise<TaskDeliveryReadiness>
>();
const buildTaskDeliveryTransitionErrorFromRules = vi.fn<
  (
    readiness: TaskDeliveryReadiness,
    targetColumnName: string,
    deliveryRules: Record<string, unknown> | undefined,
  ) => string | null
>(() => null);

const taskStore = {
  get: vi.fn<(_: string) => Promise<Task | null>>(),
  save: vi.fn<(task: Task) => Promise<void>>(),
};

const system = {
  taskStore,
  kanbanBoardStore: { get: vi.fn(), getDefault: vi.fn() },
  workspaceStore: { get: vi.fn() },
  worktreeStore: { assignSession: vi.fn(), get: vi.fn() },
  codebaseStore: { findByRepoPath: vi.fn(), get: vi.fn(), getDefault: vi.fn() },
  eventBus: {},
  artifactStore: undefined,
};

vi.mock("@/core/routa-system", () => ({
  getRoutaSystem: () => system,
}));

vi.mock("@/core/kanban/kanban-event-broadcaster", () => ({
  getKanbanEventBroadcaster: () => ({ notify }),
}));

vi.mock("@/core/kanban/task-board-context", () => ({
  ensureTaskBoardContext: vi.fn(async () => ({})),
}));

vi.mock("@/core/kanban/github-issues", () => ({
  updateGitHubIssue: vi.fn(),
}));

vi.mock("@/core/git/git-worktree-service", () => ({
  GitWorktreeService: vi.fn(class {
    createWorktree = createWorktree;
  }),
}));

vi.mock("@/core/models/workspace", () => ({
  getDefaultWorkspaceWorktreeRoot: vi.fn(),
  getEffectiveWorkspaceMetadata: vi.fn(),
}));

vi.mock("@/core/kanban/column-transition", () => ({
  emitColumnTransition: vi.fn(),
}));

vi.mock("@/core/kanban/task-session-transition", () => ({
  archiveActiveTaskSession: vi.fn(),
  prepareTaskForColumnChange: vi.fn(() => false),
}));

vi.mock("@/core/kanban/task-delivery-readiness", () => ({
  buildTaskDeliveryReadiness: (task: Task, currentSystem: typeof system) =>
    buildTaskDeliveryReadiness(task, currentSystem),
  buildTaskDeliveryTransitionErrorFromRules: (
    readiness: TaskDeliveryReadiness,
    targetColumnName: string,
    deliveryRules: Record<string, unknown> | undefined,
  ) => buildTaskDeliveryTransitionErrorFromRules(readiness, targetColumnName, deliveryRules),
}));

vi.mock("@/core/kanban/workflow-orchestrator-singleton", () => ({
  enqueueKanbanTaskSession: (currentSystem: typeof system, params: { task: Task }) =>
    enqueueKanbanTaskSession(currentSystem, params),
  getKanbanSessionQueue: () => ({ removeCardJob }),
  processKanbanColumnTransition: (...args: unknown[]) => processKanbanColumnTransition(...args),
}));

import { PATCH } from "../route";

function taskFixture(): Task {
  return createTask({
    id: "task-1",
    title: "State machine probe",
    objective: "Pin task status write guards",
    workspaceId: "workspace-1",
    boardId: "board-1",
    columnId: "todo",
    status: TaskStatus.PENDING,
    // A pre-existing session keeps the PATCH away from the dev-trigger /
    // worktree side effects so the tests stay focused on status semantics.
    triggerSessionId: "session-old",
  });
}

function callPatch(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/tasks/task-1", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ taskId: "task-1" }) },
  );
}

const idleReadiness: TaskDeliveryReadiness = {
  checked: false,
  modified: 0,
  untracked: 0,
  ahead: 0,
  behind: 0,
  commitsSinceBase: 0,
  hasCommitsSinceBase: false,
  hasUncommittedChanges: false,
  isGitHubRepo: false,
  canCreatePullRequest: false,
  reason: "Task has no linked repository or worktree.",
};

describe("PATCH /api/tasks/[taskId] — status validation guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskStore.get.mockResolvedValue(taskFixture());
    taskStore.save.mockResolvedValue(undefined);
    system.kanbanBoardStore.get.mockResolvedValue(null);
    system.kanbanBoardStore.getDefault.mockResolvedValue(null);
    system.worktreeStore.get = vi.fn().mockResolvedValue(undefined);
    system.codebaseStore.findByRepoPath = vi.fn().mockResolvedValue(undefined);
    system.codebaseStore.get = vi.fn().mockResolvedValue(undefined);
    system.codebaseStore.getDefault = vi.fn().mockResolvedValue(undefined);
    buildTaskDeliveryReadiness.mockResolvedValue(idleReadiness);
    buildTaskDeliveryTransitionErrorFromRules.mockReturnValue(null);
    enqueueKanbanTaskSession.mockResolvedValue({ sessionId: undefined, queued: false });
    processKanbanColumnTransition.mockResolvedValue(undefined);
  });

  it("rejects status values outside the TaskStatus enum", async () => {
    const response = await callPatch({ status: "IN_REVIEW" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid status: IN_REVIEW" });
    expect(taskStore.save).not.toHaveBeenCalled();
  });

  it("parses status exact-case: lowercase enum names are not normalized on PATCH", async () => {
    // Behavioral pin: POST /api/tasks/[taskId]/status uppercases its input,
    // PATCH does not. Both spellings must stay distinguishable so clients
    // cannot silently rely on normalization at this endpoint.
    const response = await callPatch({ status: "completed" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid status: completed" });
    expect(taskStore.save).not.toHaveBeenCalled();
  });

  it("rejects priority values outside the TaskPriority enum", async () => {
    const response = await callPatch({ priority: "critical" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid priority: critical" });
    expect(taskStore.save).not.toHaveBeenCalled();
  });

  it("rejects status/columnId pairs that disagree about the workflow state", async () => {
    const response = await callPatch({ status: "COMPLETED", columnId: "dev" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "columnId and status must describe the same workflow state",
    });
    expect(taskStore.save).not.toHaveBeenCalled();
  });

  it("accepts a custom board column whose semantic stage matches the terminal status", async () => {
    system.kanbanBoardStore.get.mockResolvedValue({
      id: "board-1",
      columns: [
        { id: "todo", name: "Todo", position: 0, stage: "backlog" },
        { id: "ship", name: "Ship", position: 1, stage: "done" },
      ],
    });

    const response = await callPatch({ status: "COMPLETED", columnId: "ship" });

    expect(response.status).toBe(200);
    expect(taskStore.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: TaskStatus.COMPLETED, columnId: "ship" }),
    );
  });
});

describe("PATCH /api/tasks/[taskId] — no illegal-transition table", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskStore.get.mockResolvedValue(taskFixture());
    taskStore.save.mockResolvedValue(undefined);
    system.kanbanBoardStore.get.mockResolvedValue(null);
    system.kanbanBoardStore.getDefault.mockResolvedValue(null);
    system.worktreeStore.get = vi.fn().mockResolvedValue(undefined);
    system.codebaseStore.findByRepoPath = vi.fn().mockResolvedValue(undefined);
    system.codebaseStore.get = vi.fn().mockResolvedValue(undefined);
    system.codebaseStore.getDefault = vi.fn().mockResolvedValue(undefined);
    buildTaskDeliveryReadiness.mockResolvedValue(idleReadiness);
    buildTaskDeliveryTransitionErrorFromRules.mockReturnValue(null);
    enqueueKanbanTaskSession.mockResolvedValue({ sessionId: undefined, queued: false });
    processKanbanColumnTransition.mockResolvedValue(undefined);
  });

  it("accepts every TaskStatus directly from PENDING (transition order is not enforced)", async () => {
    for (const status of Object.values(TaskStatus)) {
      taskStore.get.mockResolvedValue(taskFixture());
      (taskStore.save as ReturnType<typeof vi.fn>).mockClear();

      const response = await callPatch({ status });

      expect(response.status, `status ${status} should be writable`).toBe(200);
      expect(taskStore.save).toHaveBeenCalledWith(
        expect.objectContaining({ status }),
      );
    }
  });

  it("remaps columnId through the historical status-to-column mapping for non-terminal writes", async () => {
    await callPatch({ status: "IN_PROGRESS" });
    expect(taskStore.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: TaskStatus.IN_PROGRESS, columnId: "dev" }),
    );

    taskStore.get.mockResolvedValue(taskFixture());
    await callPatch({ status: "REVIEW_REQUIRED" });
    expect(taskStore.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: TaskStatus.REVIEW_REQUIRED, columnId: "review" }),
    );
  });

  it("resolves terminal writes onto the board's matching stage column in one write", async () => {
    system.kanbanBoardStore.get.mockResolvedValue({
      id: "board-1",
      columns: [
        { id: "todo", name: "Todo", position: 0, stage: "backlog" },
        { id: "ship", name: "Ship", position: 1, stage: "done" },
        { id: "stuck", name: "Stuck", position: 2, stage: "blocked" },
      ],
    });

    await callPatch({ status: "COMPLETED" });
    expect(taskStore.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: TaskStatus.COMPLETED, columnId: "ship" }),
    );

    taskStore.get.mockResolvedValue(taskFixture());
    await callPatch({ status: "BLOCKED" });
    expect(taskStore.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: TaskStatus.BLOCKED, columnId: "stuck" }),
    );
  });

  it("falls back to the literal terminal column id when no board context exists", async () => {
    await callPatch({ status: "COMPLETED" });

    expect(taskStore.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: TaskStatus.COMPLETED, columnId: "done" }),
    );
  });
});
