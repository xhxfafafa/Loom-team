/**
 * Team Run lifecycle e2e (hermetic).
 *
 * Covers the Web-only Team surface without a live ACP agent: every request is
 * intercepted with page.route, so the flows under test are the client wiring
 * itself —
 *
 *   1. Team run list rendering + refresh recovery (empty → repopulated);
 *   2. Team lead launch: HomeInput → POST /api/acp session/new payload
 *      contract (specialistId team-agent-lead, role ROUTA, workspaceId) and
 *      navigation to /workspace/{ws}/team/{sessionId};
 *   3. Team run detail page: member roster derived from child sessions;
 *   4. Delete flow: preview fetch, type-to-confirm gating (wrong token keeps
 *      the button disabled, "DELETE" enables it), DELETE request contract,
 *      and the success toast.
 *
 * SSE attach (GET /api/acp) is aborted: there is no agent runtime in this
 * hermetic run and the client tolerates probe failures gracefully.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const WORKSPACE_ID = "ws-team-e2e";
const ROOT_SESSION_ID = "team-root-e2e";
const NEW_SESSION_ID = "team-new-e2e";
const CHILD_ARCHITECT_ID = "team-child-architect";
const CHILD_IMPLEMENTER_ID = "team-child-implementer";
const REPO_PATH = "/tmp/e2e-team-repo";
const CREATED_AT = "2026-08-14T08:00:00.000Z";

const TEAM_LEAD = "team-agent-lead";

const workspace = {
  id: WORKSPACE_ID,
  title: "Team E2E Workspace",
  status: "active",
  metadata: {},
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const codebase = {
  id: "codebase-e2e",
  workspaceId: WORKSPACE_ID,
  repoPath: REPO_PATH,
  branch: "main",
  label: "e2e-team-repo",
  isDefault: true,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const specialists = [
  { id: TEAM_LEAD, name: "Team Lead", role: "ROUTA", defaultModelTier: "high", systemPrompt: "", roleReminder: "" },
  { id: "team-architect", name: "Architect", role: "CRAFTER", defaultModelTier: "high", systemPrompt: "", roleReminder: "" },
  { id: "team-implementer", name: "Implementer", role: "CRAFTER", defaultModelTier: "high", systemPrompt: "", roleReminder: "" },
];

const rootSession = {
  sessionId: ROOT_SESSION_ID,
  name: "E2E Seeded Team Run",
  cwd: REPO_PATH,
  branch: "main",
  workspaceId: WORKSPACE_ID,
  role: "ROUTA",
  acpStatus: "ready",
  specialistId: TEAM_LEAD,
  createdAt: CREATED_AT,
  firstPromptSent: true,
  directDelegates: 2,
  descendants: 2,
};

const createdSession = {
  ...rootSession,
  sessionId: NEW_SESSION_ID,
  name: "Team - Ship the e2e login flow",
  firstPromptSent: false,
  directDelegates: 0,
  descendants: 0,
};

const childSessions = [
  {
    sessionId: CHILD_ARCHITECT_ID,
    name: "Architect delegation",
    cwd: REPO_PATH,
    workspaceId: WORKSPACE_ID,
    role: "CRAFTER",
    acpStatus: "ready",
    parentSessionId: ROOT_SESSION_ID,
    specialistId: "team-architect",
    createdAt: CREATED_AT,
  },
  {
    sessionId: CHILD_IMPLEMENTER_ID,
    name: "Implementer delegation",
    cwd: REPO_PATH,
    workspaceId: WORKSPACE_ID,
    role: "CRAFTER",
    acpStatus: "ready",
    parentSessionId: ROOT_SESSION_ID,
    specialistId: "team-implementer",
    createdAt: CREATED_AT,
  },
];

const deletionPreview = {
  rootSessionId: ROOT_SESSION_ID,
  teamName: rootSession.name,
  workspaceId: WORKSPACE_ID,
  counts: {
    sessions: 3,
    activeAgents: 0,
    kanbanCards: 1,
    explicitKanbanCards: 1,
    legacyKanbanCards: 0,
    artifacts: 0,
    worktrees: 0,
    notes: 0,
    backgroundTasks: 0,
    preservedSharedKanbanCards: 0,
    preservedSharedWorktrees: 0,
  },
  hasRunnerSessions: false,
};

const deletionResult = {
  rootSessionId: ROOT_SESSION_ID,
  teamName: rootSession.name,
  workspaceId: WORKSPACE_ID,
  deleted: {
    agentsStopped: 0,
    sessions: 3,
    kanbanCards: 1,
    artifacts: 0,
    worktrees: 0,
    notes: 0,
    backgroundTasks: 0,
  },
  preserved: { sharedKanbanCards: 0, sharedWorktrees: 0 },
  warnings: [],
};

interface ApiStubHandles {
  /** Mutable list served by GET /api/sessions?surface=team. */
  teamRunsList: Array<Record<string, unknown>>;
  /** session/new JSON-RPC params captured from POST /api/acp. */
  sessionNewRequests: Array<Record<string, unknown>>;
  /** DELETE /api/team-runs/* URLs captured. */
  deleteRequests: string[];
}

/**
 * Single dispatcher over every /api request. Unknown endpoints get a benign
 * `{}` so background hooks (settings, diagnostics) never hit the network.
 */
async function installApiStub(page: Page): Promise<ApiStubHandles> {
  const handles: ApiStubHandles = {
    teamRunsList: [rootSession],
    sessionNewRequests: [],
    deleteRequests: [],
  };

  await page.route("**/api/**", async (route, request) => {
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    const respond = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    // ── ACP JSON-RPC ──
    if (path === "/api/acp") {
      if (method === "GET") {
        // SSE attach / probe — no live agent runtime in this hermetic spec.
        return route.abort();
      }
      const rpc = request.postDataJSON() as { id?: number; method?: string; params?: Record<string, unknown> };
      let result: unknown = {};
      if (rpc.method === "initialize") {
        result = { protocolVersion: 1 };
      } else if (rpc.method === "session/new") {
        handles.sessionNewRequests.push(rpc.params ?? {});
        result = { sessionId: NEW_SESSION_ID };
      }
      return respond({ jsonrpc: "2.0", id: rpc.id, result });
    }

    // ── Workspace surface ──
    if (path === "/api/workspaces" && method === "GET") {
      return respond({ workspaces: [workspace] });
    }
    if (path === `/api/workspaces/${WORKSPACE_ID}/codebases`) {
      if (method === "GET") return respond({ codebases: [codebase] });
      return respond({ codebase }, method === "POST" ? 201 : 200);
    }
    if (path === "/api/clone/branches") {
      return respond({ branches: ["main"], defaultBranch: "main" });
    }
    if (path === "/api/specialists") {
      return respond({ specialists });
    }
    if (path === "/api/providers") {
      return respond({
        providers: [{ id: "opencode", name: "OpenCode", status: "available", source: "static" }],
      });
    }

    // ── Sessions ──
    if (path === "/api/sessions" && method === "GET") {
      if (url.searchParams.get("surface") === "team") {
        return respond({ sessions: handles.teamRunsList });
      }
      return respond({ sessions: [rootSession, createdSession, ...childSessions] });
    }
    if (path === `/api/sessions/${ROOT_SESSION_ID}`) {
      return respond({ session: rootSession });
    }
    if (path === `/api/sessions/${NEW_SESSION_ID}`) {
      return respond({ session: createdSession });
    }
    if (path.endsWith("/transcript")) {
      return respond({ history: [], messages: [] });
    }

    // ── Team run detail page companions ──
    if (path === "/api/agents") {
      return respond({ agents: [] });
    }
    if (path === "/api/tasks") {
      return respond({ tasks: [] });
    }

    // ── Team run deletion ──
    if (/^\/api\/team-runs\/[^/]+\/preview$/.test(path)) {
      return respond(deletionPreview);
    }
    if (/^\/api\/team-runs\/[^/]+$/.test(path) && method === "DELETE") {
      handles.deleteRequests.push(url.toString());
      return respond({ ok: true, result: deletionResult });
    }

    return respond({});
  });

  return handles;
}

test.describe("Team run lifecycle (hermetic)", () => {
  test("lists seeded team runs and recovers through refresh", async ({ page }) => {
    const stub = await installApiStub(page);

    await page.goto(`/workspace/${WORKSPACE_ID}/team`);

    const runCard = page.getByRole("button", { name: /E2E Seeded Team Run/ });
    await expect(runCard).toBeVisible();

    // Refresh with an emptied list surfaces the empty state…
    stub.teamRunsList = [];
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByText("No Team runs yet.")).toBeVisible();

    // …and a second refresh repopulates the list (recovery, no reload).
    stub.teamRunsList = [rootSession];
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(runCard).toBeVisible();
  });

  test("launches a team lead through session/new and navigates to the run", async ({ page }) => {
    const stub = await installApiStub(page);

    await page.goto(`/workspace/${WORKSPACE_ID}/team`);

    // HomeInput enables once the ACP client is connected and the single
    // accessible codebase is auto-selected.
    const editor = page.getByTestId("tiptap-editor");
    await expect(editor).toBeVisible();
    await editor.click();
    await editor.pressSequentially("Ship the e2e login flow");

    await page.getByTestId("tiptap-send-button").click();

    await page.waitForURL(`**/workspace/${WORKSPACE_ID}/team/${NEW_SESSION_ID}`);

    expect(stub.sessionNewRequests).toHaveLength(1);
    const params = stub.sessionNewRequests[0];
    expect(params.specialistId).toBe(TEAM_LEAD);
    expect(params.role).toBe("ROUTA");
    expect(params.workspaceId).toBe(WORKSPACE_ID);
    expect(params.cwd).toBe(REPO_PATH);
    expect(params.provider).toBe("opencode");
    expect(typeof params.idempotencyKey).toBe("string");
  });

  test("shows the member roster derived from child sessions on the run page", async ({ page }) => {
    await installApiStub(page);

    await page.goto(`/workspace/${WORKSPACE_ID}/team/${ROOT_SESSION_ID}`);

    await expect(page.getByText("Team Members")).toBeVisible();
    // The roster falls back to team-category specialists; child sessions are
    // linked to their specialists.
    await expect(page.getByText("Team Lead", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Architect", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Implementer", { exact: true }).first()).toBeVisible();
  });

  test("gates deletion behind the confirm token and reports the result", async ({ page }) => {
    const stub = await installApiStub(page);

    await page.goto(`/workspace/${WORKSPACE_ID}/team`);
    await expect(page.getByRole("button", { name: /E2E Seeded Team Run/ })).toBeVisible();

    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete Team Run" }).click();

    const dialog = page.getByRole("dialog", { name: "Delete this Team Run?" });
    await expect(dialog).toBeVisible();

    // Preview stats render from the preview endpoint.
    await expect(dialog.getByText("Sessions", { exact: true })).toBeVisible();

    const confirmInput = dialog.getByPlaceholder("Type to confirm");
    const deleteButton = dialog.getByRole("button", { name: "Delete Team Run" });

    // No token yet → disabled; wrong token → still disabled.
    await expect(deleteButton).toBeDisabled();
    await confirmInput.fill("nope");
    await expect(deleteButton).toBeDisabled();

    // The documented token enables the destructive action.
    await confirmInput.fill("DELETE");
    await expect(deleteButton).toBeEnabled();
    await deleteButton.click();

    expect(stub.deleteRequests).toHaveLength(1);
    expect(stub.deleteRequests[0]).toContain(`/api/team-runs/${ROOT_SESSION_ID}`);
    expect(stub.deleteRequests[0]).toContain(`workspaceId=${WORKSPACE_ID}`);

    // Dialog closes and the success toast summarizes what was deleted.
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Deleted Team Run: 3 sessions, 1 kanban cards, 0 worktrees.")).toBeVisible();
  });
});
