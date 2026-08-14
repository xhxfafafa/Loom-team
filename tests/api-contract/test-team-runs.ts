/**
 * Team Run API contract tests.
 *
 * Pins the Web contract for Team Run surfaces:
 * - GET /api/tasks?teamRunId= filtering (workspace-scoped, never leaks)
 * - GET /api/team-runs/:rootSessionId/preview (deletion impact preview)
 * - DELETE /api/team-runs/:rootSessionId (guarded Team Run deletion)
 *
 * These are the Web successors of the Rust `rust_api_tasks_team_run`
 * coverage: team-run task filtering is workspace-isolated, and the
 * deletion endpoints enforce workspace + team-root guards server-side.
 */

import {
  api,
  assert,
  assertStatus,
  assertArrayField,
  assertHasField,
  type TestResult,
} from "./helpers";

export async function testTeamRuns(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const suffix = Date.now();
  let workspaceId = "";
  let taskId = "";

  // ── Setup: dedicated workspace + one task ──
  results.push(
    await runTest("setup — create workspace for team-run contract", async () => {
      const { status, data } = await api("POST", "/api/workspaces", {
        title: `Team Run Contract WS ${suffix}`,
        repoPath: "/tmp/team-run-contract",
        branch: "main",
      });
      assert(status === 200 || status === 201, `Expected 200 or 201, got ${status}`);
      const d = data as Record<string, unknown>;
      assertHasField(d, "workspace");
      const ws = d.workspace as Record<string, unknown>;
      assert(typeof ws.id === "string" && ws.id.length > 0, "workspace.id required");
      workspaceId = ws.id as string;
    })
  );

  results.push(
    await runTest("setup — create task inside the contract workspace", async () => {
      if (!workspaceId) throw new Error("Depends on workspace create");
      const { status, data } = await api("POST", "/api/tasks", {
        title: `Team Run Contract Task ${suffix}`,
        objective: "Pin teamRunId workspace isolation",
        workspaceId,
      });
      assertStatus(status, 201);
      const d = data as Record<string, unknown>;
      assertHasField(d, "task");
      const task = d.task as Record<string, unknown>;
      assert(typeof task.id === "string" && task.id.length > 0, "task.id required");
      taskId = task.id as string;
    })
  );

  // ── GET /api/tasks?teamRunId= — filter contract ──
  results.push(
    await runTest("GET /api/tasks?teamRunId= — unknown team run yields empty list", async () => {
      if (!workspaceId) throw new Error("Depends on workspace create");
      const { status, data } = await api(
        "GET",
        `/api/tasks?workspaceId=${encodeURIComponent(workspaceId)}&teamRunId=team-run-contract-${suffix}`
      );
      assertStatus(status, 200);
      const d = data as Record<string, unknown>;
      assertArrayField(d, "tasks");
      assert((d.tasks as unknown[]).length === 0, "Unknown teamRunId must not match any task");
    })
  );

  results.push(
    await runTest("GET /api/tasks?teamRunId= — never leaks tasks across workspaces", async () => {
      if (!workspaceId || !taskId) throw new Error("Depends on task create");
      // The task lives in workspaceId without a teamRunId; querying any other
      // workspace with any teamRunId must return nothing.
      const { status, data } = await api(
        "GET",
        `/api/tasks?workspaceId=contract-other-ws-${suffix}&teamRunId=team-run-contract-${suffix}`
      );
      assertStatus(status, 200);
      const d = data as Record<string, unknown>;
      assertArrayField(d, "tasks");
      const ids = (d.tasks as Array<Record<string, unknown>>).map((t) => t.id);
      assert(!ids.includes(taskId), "Task must not leak into another workspace's team-run filter");
    })
  );

  results.push(
    await runTest("GET /api/tasks?teamRunId= — still requires workspaceId", async () => {
      const { status, data } = await api("GET", "/api/tasks?teamRunId=team-run-contract-x");
      assertStatus(status, 400);
      const d = data as Record<string, unknown>;
      assert(typeof d.error === "string" && d.error.includes("workspaceId"), "error should mention workspaceId");
    })
  );

  results.push(
    await runTest("GET /api/tasks — unfiltered list still returns the workspace task", async () => {
      if (!workspaceId || !taskId) throw new Error("Depends on task create");
      const { status, data } = await api(
        "GET",
        `/api/tasks?workspaceId=${encodeURIComponent(workspaceId)}`
      );
      assertStatus(status, 200);
      const d = data as Record<string, unknown>;
      const ids = (d.tasks as Array<Record<string, unknown>>).map((t) => t.id);
      assert(ids.includes(taskId), "Unfiltered workspace list must include the created task");
    })
  );

  // ── GET /api/team-runs/:id/preview — deletion impact preview contract ──
  results.push(
    await runTest("GET /api/team-runs/{id}/preview — unknown root returns 404 TEAM_RUN_NOT_FOUND", async () => {
      const { status, data } = await api(
        "GET",
        `/api/team-runs/contract-unknown-root-${suffix}/preview`
      );
      assertStatus(status, 404);
      const d = data as Record<string, unknown>;
      assert(d.ok === false, "ok should be false");
      const error = d.error as Record<string, unknown>;
      assert(error?.code === "TEAM_RUN_NOT_FOUND", `Expected TEAM_RUN_NOT_FOUND, got ${error?.code}`);
    })
  );

  results.push(
    await runTest("GET /api/team-runs/{id}/preview — workspace hint does not change not-found outcome", async () => {
      if (!workspaceId) throw new Error("Depends on workspace create");
      const { status, data } = await api(
        "GET",
        `/api/team-runs/contract-unknown-root-${suffix}/preview?workspaceId=${encodeURIComponent(workspaceId)}`
      );
      assertStatus(status, 404);
      const d = data as Record<string, unknown>;
      const error = d.error as Record<string, unknown>;
      assert(error?.code === "TEAM_RUN_NOT_FOUND", `Expected TEAM_RUN_NOT_FOUND, got ${error?.code}`);
    })
  );

  // ── DELETE /api/team-runs/:id — guarded deletion contract ──
  results.push(
    await runTest("DELETE /api/team-runs/{id} — missing workspaceId returns 400 TEAM_RUN_WORKSPACE_REQUIRED", async () => {
      const { status, data } = await api("DELETE", `/api/team-runs/contract-unknown-root-${suffix}`);
      assertStatus(status, 400);
      const d = data as Record<string, unknown>;
      assert(d.ok === false, "ok should be false");
      const error = d.error as Record<string, unknown>;
      assert(
        error?.code === "TEAM_RUN_WORKSPACE_REQUIRED",
        `Expected TEAM_RUN_WORKSPACE_REQUIRED, got ${error?.code}`
      );
    })
  );

  results.push(
    await runTest("DELETE /api/team-runs/{id} — unknown root returns 404 TEAM_RUN_NOT_FOUND", async () => {
      if (!workspaceId) throw new Error("Depends on workspace create");
      const { status, data } = await api(
        "DELETE",
        `/api/team-runs/contract-unknown-root-${suffix}?workspaceId=${encodeURIComponent(workspaceId)}`
      );
      assertStatus(status, 404);
      const d = data as Record<string, unknown>;
      const error = d.error as Record<string, unknown>;
      assert(error?.code === "TEAM_RUN_NOT_FOUND", `Expected TEAM_RUN_NOT_FOUND, got ${error?.code}`);
    })
  );

  // ── Cleanup ──
  results.push(
    await runTest("cleanup — delete contract task and workspace", async () => {
      if (taskId) {
        const taskDelete = await api("DELETE", `/api/tasks/${taskId}`);
        assertStatus(taskDelete.status, 200);
      }
      if (workspaceId) {
        const wsDelete = await api("DELETE", `/api/workspaces/${workspaceId}`);
        assertStatus(wsDelete.status, 200);
      }
    })
  );

  return results;
}

async function runTest(
  name: string,
  fn: () => Promise<void>
): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
    };
  }
}
