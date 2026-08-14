/**
 * Kanban board API contract tests.
 *
 * Pins the Web contract for the Kanban board surface:
 * - GET/POST /api/kanban/boards (list incl. default board, create)
 * - GET/PATCH /api/kanban/boards/{boardId} (read, update)
 * - GET /api/kanban/export + POST /api/kanban/import (YAML roundtrip)
 *
 * These are the Web successors of the Rust `rust_api_kanban_board_tokens`
 * and kanban import/export roundtrip coverage: github tokens are stored but
 * never serialized raw, and an exported config re-imports losslessly.
 */

import {
  BASE_URL,
  api,
  assert,
  assertStatus,
  assertArrayField,
  assertHasField,
  type TestResult,
} from "./helpers";

export async function testKanban(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const suffix = Date.now();
  let workspaceId = "";
  let boardId = "";
  const importedWorkspaceId = `kanban-import-${suffix}`;
  let exportedYaml = "";
  let createdColumnIds: string[] = [];

  // ── Setup: dedicated workspace ──
  results.push(
    await runTest("setup — create workspace for kanban contract", async () => {
      const { status, data } = await api("POST", "/api/workspaces", {
        title: `Kanban Contract WS ${suffix}`,
        repoPath: "/tmp/kanban-contract",
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

  // ── GET /api/kanban/boards — list contract ──
  results.push(
    await runTest("GET /api/kanban/boards — requires workspaceId", async () => {
      const { status, data } = await api("GET", "/api/kanban/boards");
      assertStatus(status, 400);
      const d = data as Record<string, unknown>;
      assert(typeof d.error === "string" && d.error.includes("workspaceId"), "error should mention workspaceId");
    })
  );

  results.push(
    await runTest("GET /api/kanban/boards — auto-provisions a default board", async () => {
      if (!workspaceId) throw new Error("Depends on workspace create");
      const { status, data } = await api("GET", `/api/kanban/boards?workspaceId=${encodeURIComponent(workspaceId)}`);
      assertStatus(status, 200);
      const d = data as Record<string, unknown>;
      assertArrayField(d, "boards");
      const boards = d.boards as Array<Record<string, unknown>>;
      assert(boards.length >= 1, "Expected at least the auto-provisioned default board");
      const hasDefault = boards.some((board) => board.isDefault === true);
      assert(hasDefault, "Expected exactly one default board after provisioning");
      for (const board of boards) {
        assert(!("githubToken" in board) || board.githubToken === undefined, "raw githubToken must never be serialized");
        assert(typeof board.githubTokenConfigured === "boolean", "githubTokenConfigured must be a boolean");
        assertArrayField(board, "columns");
      }
    })
  );

  // ── POST /api/kanban/boards — create contract ──
  results.push(
    await runTest("POST /api/kanban/boards — creates a board with custom columns", async () => {
      if (!workspaceId) throw new Error("Depends on workspace create");
      const columns = [
        { id: "todo", name: "Todo", position: 0, stage: "backlog" },
        { id: "doing", name: "Doing", position: 1, stage: "dev" },
        { id: "shipped", name: "Shipped", position: 2, stage: "done" },
      ];
      const { status, data } = await api("POST", "/api/kanban/boards", {
        workspaceId,
        name: `Contract Board ${suffix}`,
        columns,
      });
      assertStatus(status, 201);
      const d = data as Record<string, unknown>;
      assertHasField(d, "board");
      const board = d.board as Record<string, unknown>;
      assert(typeof board.id === "string" && board.id.length > 0, "board.id required");
      assert(board.name === `Contract Board ${suffix}`, "board.name should match the trimmed request name");
      assert(board.githubToken === undefined, "created board must not expose githubToken");
      assert(board.githubTokenConfigured === false, "created board reports githubTokenConfigured false");
      createdColumnIds = (board.columns as Array<Record<string, unknown>>).map((column) => String(column.id));
      assert(
        JSON.stringify(createdColumnIds) === JSON.stringify(["todo", "doing", "shipped"]),
        `custom columns preserved, got ${createdColumnIds.join(",")}`
      );
      boardId = board.id as string;
    })
  );

  results.push(
    await runTest("POST /api/kanban/boards — rejects missing name", async () => {
      if (!workspaceId) throw new Error("Depends on workspace create");
      const { status, data } = await api("POST", "/api/kanban/boards", { workspaceId });
      assertStatus(status, 400);
      const d = data as Record<string, unknown>;
      assert(d.error === "name is required", `Expected "name is required", got ${d.error}`);
    })
  );

  // ── GET/PATCH /api/kanban/boards/{boardId} — read/update contract ──
  results.push(
    await runTest("GET /api/kanban/boards/{id} — returns the created board", async () => {
      if (!boardId) throw new Error("Depends on board create");
      const { status, data } = await api("GET", `/api/kanban/boards/${boardId}`);
      assertStatus(status, 200);
      const d = data as Record<string, unknown>;
      assertHasField(d, "board");
      const board = d.board as Record<string, unknown>;
      assert(board.id === boardId, "board.id should match the requested id");
      assert(board.workspaceId === workspaceId, "board.workspaceId should match");
    })
  );

  results.push(
    await runTest("GET /api/kanban/boards/{id} — unknown board returns 404", async () => {
      const { status, data } = await api("GET", `/api/kanban/boards/contract-missing-board-${suffix}`);
      assertStatus(status, 404);
      const d = data as Record<string, unknown>;
      assert(d.error === "Board not found", `Expected "Board not found", got ${d.error}`);
    })
  );

  results.push(
    await runTest("PATCH /api/kanban/boards/{id} — stores a github token but never returns it raw", async () => {
      if (!boardId) throw new Error("Depends on board create");
      const token = `ghp_contract_${suffix}`;
      const { status, data } = await api("PATCH", `/api/kanban/boards/${boardId}`, {
        name: `Renamed Contract Board ${suffix}`,
        githubToken: token,
      });
      assertStatus(status, 200);
      const d = data as Record<string, unknown>;
      const board = d.board as Record<string, unknown>;
      assert(board.name === `Renamed Contract Board ${suffix}`, "rename should be applied");
      assert(board.githubToken === undefined, "PATCH response must not expose the raw token");
      assert(board.githubTokenConfigured === true, "githubTokenConfigured should be true after set");
      assert(!JSON.stringify(d).includes(token), "raw token must not appear anywhere in the response");
    })
  );

  results.push(
    await runTest("GET /api/kanban/boards/{id} — token persists but stays masked on re-read", async () => {
      if (!boardId) throw new Error("Depends on token PATCH");
      const { status, data } = await api("GET", `/api/kanban/boards/${boardId}`);
      assertStatus(status, 200);
      const d = data as Record<string, unknown>;
      const board = d.board as Record<string, unknown>;
      assert(board.name === `Renamed Contract Board ${suffix}`, "rename should be persisted");
      assert(board.githubToken === undefined, "re-read must not expose the raw token");
      assert(board.githubTokenConfigured === true, "persisted token should still be reported as configured");
      assert(!JSON.stringify(d).includes(`ghp_contract_${suffix}`), "persisted token must not leak on re-read");
    })
  );

  results.push(
    await runTest("PATCH /api/kanban/boards/{id} — clearGitHubToken removes the stored token", async () => {
      if (!boardId) throw new Error("Depends on token PATCH");
      const { status, data } = await api("PATCH", `/api/kanban/boards/${boardId}`, {
        clearGitHubToken: true,
      });
      assertStatus(status, 200);
      const d = data as Record<string, unknown>;
      const board = d.board as Record<string, unknown>;
      assert(board.githubTokenConfigured === false, "token should be cleared");

      const reread = await api("GET", `/api/kanban/boards/${boardId}`);
      const rereadBoard = (reread.data as Record<string, unknown>).board as Record<string, unknown>;
      assert(rereadBoard.githubTokenConfigured === false, "cleared token should stay cleared on re-read");
    })
  );

  // ── Export / import roundtrip ──
  results.push(
    await runTest("GET /api/kanban/export — returns YAML with the workspace boards", async () => {
      if (!workspaceId) throw new Error("Depends on workspace create");
      const res = await fetch(`${BASE_URL}/api/kanban/export?workspaceId=${encodeURIComponent(workspaceId)}`);
      assertStatus(res.status, 200);
      assert(
        (res.headers.get("Content-Type") ?? "").includes("application/yaml"),
        `Expected application/yaml content type, got ${res.headers.get("Content-Type")}`
      );
      assert(
        (res.headers.get("Content-Disposition") ?? "").includes("kanban-"),
        "Expected an attachment Content-Disposition with a kanban- filename"
      );
      exportedYaml = await res.text();
      assert(exportedYaml.includes("version: 1"), "export should declare version 1");
      assert(exportedYaml.includes(`Renamed Contract Board ${suffix}`), "export should contain the created board");
    })
  );

  results.push(
    await runTest("GET /api/kanban/export — requires workspaceId", async () => {
      const { status } = await api("GET", "/api/kanban/export");
      assertStatus(status, 400);
    })
  );

  results.push(
    await runTest("POST /api/kanban/import — re-importing into the same workspace is idempotent", async () => {
      if (!exportedYaml || !workspaceId) throw new Error("Depends on export");
      const before = await api("GET", `/api/kanban/boards?workspaceId=${encodeURIComponent(workspaceId)}`);
      const beforeCount = (before.data as Record<string, unknown>).boards as unknown[];

      const { status, data } = await api("POST", "/api/kanban/import", {
        yamlContent: exportedYaml,
        workspaceId,
      });
      assertStatus(status, 200);
      const d = data as Record<string, unknown>;
      assert(d.workspaceId === workspaceId, "import should honor the workspaceId override");
      assertArrayField(d, "applied");
      const applied = d.applied as Array<Record<string, unknown>>;
      assert(applied.length >= 2, "import should apply the default and the contract board");
      assert(applied.every((entry) => entry.action === "updated"), "same-workspace import should update existing boards");

      const after = await api("GET", `/api/kanban/boards?workspaceId=${encodeURIComponent(workspaceId)}`);
      const boards = (after.data as Record<string, unknown>).boards as Array<Record<string, unknown>>;
      assert(boards.length === beforeCount.length, "same-workspace re-import must not duplicate boards");
      const roundtripped = boards.find((board) => String(board.name).includes("Renamed Contract Board"));
      assert(Boolean(roundtripped), "contract board should survive the export/import roundtrip");
      const columnIds = (roundtripped?.columns as Array<Record<string, unknown>>).map((column) => String(column.id));
      assert(
        JSON.stringify(columnIds) === JSON.stringify(createdColumnIds),
        `roundtripped columns should match the export, got ${columnIds.join(",")}`
      );
      // Tokens never travel through the export format.
      assert(roundtripped?.githubTokenConfigured === false, "a cleared token must stay cleared after roundtrip");
    })
  );

  results.push(
    await runTest("POST /api/kanban/import — cross-workspace import upserts by board id, never duplicates", async () => {
      // Baseline behavior pin (pre-existing, not migration-induced): board
      // ids are globally unique and the store upserts on id without
      // re-scoping workspaceId. Importing an export into a different
      // workspace therefore reports "created" (the target had no boards)
      // but the exported boards stay anchored in the source workspace.
      if (!exportedYaml) throw new Error("Depends on export");
      const { status, data } = await api("POST", "/api/kanban/import", {
        yamlContent: exportedYaml,
        workspaceId: importedWorkspaceId,
      });
      assertStatus(status, 200);
      const d = data as Record<string, unknown>;
      assert(d.workspaceId === importedWorkspaceId, "import should create/honor the override workspace");
      const applied = d.applied as Array<Record<string, unknown>>;
      assert(applied.length >= 2, "import should process every exported board");
      assert(applied.every((entry) => entry.action === "created"), "import into an empty workspace reports created");

      // The source workspace keeps every exported board, unchanged.
      const source = await api("GET", `/api/kanban/boards?workspaceId=${encodeURIComponent(workspaceId)}`);
      const sourceBoards = (source.data as Record<string, unknown>).boards as Array<Record<string, unknown>>;
      const exportedIds = applied.map((entry) => String(entry.boardId));
      for (const exportedId of exportedIds) {
        assert(
          sourceBoards.some((board) => board.id === exportedId),
          `exported board ${exportedId} must stay anchored in the source workspace`
        );
      }

      // The target workspace does not receive duplicates; listing it
      // auto-provisions a default board instead.
      const target = await api("GET", `/api/kanban/boards?workspaceId=${encodeURIComponent(importedWorkspaceId)}`);
      const targetBoards = (target.data as Record<string, unknown>).boards as Array<Record<string, unknown>>;
      assert(targetBoards.length >= 1, "target workspace should list an auto-provisioned board");
      for (const exportedId of exportedIds) {
        assert(
          !targetBoards.some((board) => board.id === exportedId),
          `exported board ${exportedId} must not be duplicated into the target workspace`
        );
      }
    })
  );

  results.push(
    await runTest("POST /api/kanban/import — rejects missing or unsupported configs", async () => {
      const missing = await api("POST", "/api/kanban/import", { yamlContent: "   " });
      assertStatus(missing.status, 400);
      assert(
        (missing.data as Record<string, unknown>).error === "yamlContent is required",
        "blank yamlContent should be rejected"
      );

      const badVersion = await api("POST", "/api/kanban/import", {
        yamlContent: "version: 99\nboards:\n  - id: b1\n    name: B\n    columns: []\n",
        workspaceId: importedWorkspaceId,
      });
      assertStatus(badVersion.status, 400);
      assert(
        (badVersion.data as Record<string, unknown>).error === "Unsupported kanban config version",
        "unsupported version should be rejected"
      );
    })
  );

  // ── Cleanup ──
  results.push(
    await runTest("cleanup — delete contract workspaces", async () => {
      if (workspaceId) {
        const wsDelete = await api("DELETE", `/api/workspaces/${workspaceId}`);
        assertStatus(wsDelete.status, 200);
      }
      if (importedWorkspaceId) {
        const importedDelete = await api("DELETE", `/api/workspaces/${importedWorkspaceId}`);
        assertStatus(importedDelete.status, 200);
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
