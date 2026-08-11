/**
 * Standalone MCP HTTP server — ACP session context propagation.
 *
 * Covers the full chain fixed for
 * docs/issues/2026-08-12-standalone-mcp-loses-team-session-context.md:
 *
 *   /mcp?wsId=...&sid=<acp-session>
 *     -> RoutaMcpHttpServer reads `sid` when creating a transport
 *     -> createRoutaMcpServer({ workspaceId, toolMode, sessionId })
 *     -> RoutaMcpToolManager resolves the owning Team Run server-side
 *     -> create_task persists task.teamRunId
 *     -> Team Run deletion preview/delete matches the card explicitly
 *
 * The tests run a real RoutaMcpHttpServer + real MCP SDK client over HTTP
 * against an in-memory RoutaSystem. Only infrastructure singletons that
 * require a database or live agent processes are replaced with test doubles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted test doubles ────────────────────────────────────────────────

const systemRef = vi.hoisted(() => ({ current: undefined as unknown }));
const sessionStoreState = vi.hoisted(() => ({ current: [] as Record<string, unknown>[] }));
const createRoutaMcpServerSpy = vi.hoisted(() => vi.fn());

vi.mock("@/core/routa-system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/routa-system")>();
  return {
    ...actual,
    getRoutaSystem: () => systemRef.current,
  };
});

vi.mock("@/core/acp/http-session-store", () => ({
  getHttpSessionStore: () => ({
    hydrateFromDb: async () => {},
    listSessions: () => sessionStoreState.current,
  }),
}));

vi.mock("@/core/orchestration/orchestrator-singleton", () => ({
  initRoutaOrchestrator: () => ({
    getSessionForAgent: () => undefined,
    delegateTaskWithSpawn: async () => ({
      success: false,
      error: "delegation is not used in these tests",
    }),
  }),
}));

vi.mock("@/core/kanban/workflow-orchestrator-singleton", () => ({
  startWorkflowOrchestrator: () => {},
}));

// Force the in-memory deletion path in team-run-deletion (no real database).
vi.mock("@/core/db/index", () => ({
  getDatabaseDriver: () => "memory",
  getPostgresDatabase: () => {
    throw new Error("postgres driver is not used in these tests");
  },
}));

// Wrap the real server factory so tests can assert how the standalone HTTP
// transport passes the URL `sid` into it, without changing its behavior.
vi.mock("../routa-mcp-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routa-mcp-server")>();
  createRoutaMcpServerSpy.mockImplementation((...args: unknown[]) =>
    (actual.createRoutaMcpServer as (...factoryArgs: unknown[]) => unknown)(...args),
  );
  return { ...actual, createRoutaMcpServer: createRoutaMcpServerSpy };
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { RoutaMcpHttpServer } from "../routa-mcp-http-server";
import { createInMemorySystem, type RoutaSystem } from "@/core/routa-system";
import {
  buildTeamRunDeletionPlan,
  deleteTeamRun,
  type TeamRunDeletionPorts,
  type TeamRunSessionRecord,
} from "@/core/orchestration/team-run-deletion";

// ─── Session fixtures ────────────────────────────────────────────────────

function teamASessions(): TeamRunSessionRecord[] {
  return [
    {
      sessionId: "team-a-root",
      workspaceId: "ws-1",
      name: "Team - Alpha",
      role: "ROUTA",
      specialistId: "team-agent-lead",
      parentSessionId: undefined,
      cwd: "/repo/team-a",
    },
    {
      sessionId: "team-a-child",
      workspaceId: "ws-1",
      name: "worker-a",
      role: "claude",
      parentSessionId: "team-a-root",
      cwd: "/repo/team-a",
    },
  ];
}

function teamBSessions(): TeamRunSessionRecord[] {
  return [
    {
      sessionId: "team-b-root",
      workspaceId: "ws-1",
      name: "Team - Beta",
      role: "ROUTA",
      specialistId: "team-agent-lead",
      parentSessionId: undefined,
      cwd: "/repo/team-b",
    },
    {
      sessionId: "team-b-child",
      workspaceId: "ws-1",
      name: "worker-b",
      role: "codex",
      parentSessionId: "team-b-root",
      cwd: "/repo/team-b",
    },
  ];
}

function soloSession(): TeamRunSessionRecord {
  return {
    sessionId: "solo-session",
    workspaceId: "ws-1",
    name: "Regular session",
    role: "claude",
    parentSessionId: undefined,
    cwd: "/repo/solo",
  };
}

function seedSessions(sessions: TeamRunSessionRecord[]): void {
  sessionStoreState.current = sessions as unknown as Record<string, unknown>[];
}

// ─── Deletion ports backed by the same in-memory system ──────────────────

function createTestDeletionPorts(system: RoutaSystem): TeamRunDeletionPorts {
  return {
    listSessions: () => sessionStoreState.current as unknown as TeamRunSessionRecord[],
    hasActiveProcess: () => false,
    killSessionProcess: async () => {},
    system,
    clearInMemorySession: () => {},
    notifyTaskDeleted: () => {},
  };
}

// ─── MCP client helpers ──────────────────────────────────────────────────

async function connectMcpClient(
  server: RoutaMcpHttpServer,
  options: { sid?: string } = {},
): Promise<Client> {
  const url = new URL(server.mcpUrl);
  url.searchParams.set("wsId", "ws-1");
  if (options.sid) {
    url.searchParams.set("sid", options.sid);
  }
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "team-ownership-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function createTaskViaMcp(
  client: Client,
  title: string,
  extraArguments: Record<string, unknown> = {},
): Promise<{ taskId: string }> {
  const result = await client.callTool({
    name: "create_task",
    arguments: { title, objective: `Objective for ${title}`, ...extraArguments },
  });
  const content = result.content as Array<{ type: string; text?: string }>;
  const firstBlock = content[0];
  expect(result.isError ?? false).toBe(false);
  const payload = JSON.parse(firstBlock.text ?? "{}") as { taskId?: string };
  expect(payload.taskId).toBeTruthy();
  return { taskId: payload.taskId as string };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("RoutaMcpHttpServer team session context", () => {
  let system: RoutaSystem;
  const servers: RoutaMcpHttpServer[] = [];
  const clients: Client[] = [];

  beforeEach(() => {
    system = createInMemorySystem();
    systemRef.current = system;
    seedSessions([]);
    createRoutaMcpServerSpy.mockClear();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      try {
        await client.close();
      } catch {
        // Transport may already be gone; cleanup must not fail the test.
      }
    }
    for (const server of servers.splice(0)) {
      await server.stop();
    }
  });

  async function startServer(): Promise<RoutaMcpHttpServer> {
    const server = new RoutaMcpHttpServer("ws-1");
    servers.push(server);
    await server.start();
    return server;
  }

  async function trackClient(client: Client): Promise<Client> {
    clients.push(client);
    return client;
  }

  it("passes the URL sid as sessionId when creating a transport/server", async () => {
    seedSessions(teamASessions());
    const server = await startServer();

    await trackClient(await connectMcpClient(server, { sid: "team-a-root" }));
    expect(createRoutaMcpServerSpy).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      toolMode: "essential",
      sessionId: "team-a-root",
    });

    // A request without sid keeps the existing no-session-context behavior.
    await trackClient(await connectMcpClient(server));
    expect(createRoutaMcpServerSpy).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      toolMode: "essential",
      sessionId: undefined,
    });
  });

  it("persists teamRunId of the Team root when a child session creates a task", async () => {
    seedSessions(teamASessions());
    const server = await startServer();
    const client = await trackClient(await connectMcpClient(server, { sid: "team-a-child" }));

    const { taskId } = await createTaskViaMcp(client, "Child agent card");

    // Re-read from the task store: ownership must be durable, not in-flight.
    const stored = await system.taskStore.get(taskId);
    expect(stored).toBeDefined();
    expect(stored?.teamRunId).toBe("team-a-root");
    expect(stored?.workspaceId).toBe("ws-1");
  });

  it("never stamps teamRunId without a sid or for a normal non-team session", async () => {
    seedSessions([...teamASessions(), soloSession()]);
    const server = await startServer();

    // No sid at all → no session context → no ownership.
    const bareClient = await trackClient(await connectMcpClient(server));
    const bareTask = await createTaskViaMcp(bareClient, "No session card");
    expect((await system.taskStore.get(bareTask.taskId))?.teamRunId).toBeUndefined();

    // A normal (non-team) session → still no ownership.
    const soloClient = await trackClient(await connectMcpClient(server, { sid: "solo-session" }));
    const soloTask = await createTaskViaMcp(soloClient, "Solo session card");
    expect((await system.taskStore.get(soloTask.taskId))?.teamRunId).toBeUndefined();
  });

  it("ignores client-forged teamRunId and keeps the server-derived owner", async () => {
    seedSessions([...teamASessions(), ...teamBSessions(), soloSession()]);
    const server = await startServer();

    // A Team A child session trying to claim Team B's ownership: the server
    // derived owner wins.
    const teamClient = await trackClient(await connectMcpClient(server, { sid: "team-a-child" }));
    const forgedOnTeam = await createTaskViaMcp(teamClient, "Forged cross-team card", {
      teamRunId: "team-b-root",
    });
    expect((await system.taskStore.get(forgedOnTeam.taskId))?.teamRunId).toBe("team-a-root");

    // A normal session trying to claim any team ownership gets none.
    const soloClient = await trackClient(await connectMcpClient(server, { sid: "solo-session" }));
    const forgedOnSolo = await createTaskViaMcp(soloClient, "Forged solo card", {
      teamRunId: "team-a-root",
    });
    expect((await system.taskStore.get(forgedOnSolo.taskId))?.teamRunId).toBeUndefined();
  });

  it("keeps two independent transports for Team A and Team B isolated", async () => {
    seedSessions([...teamASessions(), ...teamBSessions()]);
    const server = await startServer();

    const clientA = await trackClient(await connectMcpClient(server, { sid: "team-a-child" }));
    const clientB = await trackClient(await connectMcpClient(server, { sid: "team-b-child" }));

    const taskA = await createTaskViaMcp(clientA, "Team A card");
    const taskB = await createTaskViaMcp(clientB, "Team B card");

    expect((await system.taskStore.get(taskA.taskId))?.teamRunId).toBe("team-a-root");
    expect((await system.taskStore.get(taskB.taskId))?.teamRunId).toBe("team-b-root");
  });

  it("counts team-created cards in the deletion preview and deletes them with the team", async () => {
    seedSessions(teamASessions());
    const server = await startServer();
    const client = await trackClient(await connectMcpClient(server, { sid: "team-a-child" }));

    const first = await createTaskViaMcp(client, "Team card 1");
    const second = await createTaskViaMcp(client, "Team card 2");

    const ports = createTestDeletionPorts(system);

    // Preview (same plan the DELETE executes): both cards are explicit
    // ownership matches; the preview route reports this count as
    // `explicitKanbanCards`.
    const plan = await buildTeamRunDeletionPlan(ports, "team-a-root", "ws-1");
    expect([...plan.explicitKanbanTaskIds].sort()).toEqual(
      [first.taskId, second.taskId].sort(),
    );
    expect(plan.kanbanTaskIds).toHaveLength(2);
    expect(plan.legacyKanbanTaskIds).toHaveLength(0);
    expect(plan.sharedKanbanTaskIds).toHaveLength(0);

    const result = await deleteTeamRun(ports, "team-a-root", "ws-1");
    expect(result.deleted.kanbanCards).toBe(2);
    expect(result.deleted.sessions).toBe(2);

    // The cards are gone from the store after deletion.
    const remaining = await system.taskStore.listByWorkspace("ws-1");
    expect(remaining.map((task) => task.id)).not.toContain(first.taskId);
    expect(remaining.map((task) => task.id)).not.toContain(second.taskId);
  });

  it("keeps other teams' cards and manual cards untouched when deleting a team", async () => {
    seedSessions([...teamASessions(), ...teamBSessions(), soloSession()]);
    const server = await startServer();

    const clientA = await trackClient(await connectMcpClient(server, { sid: "team-a-child" }));
    const clientB = await trackClient(await connectMcpClient(server, { sid: "team-b-child" }));
    const manualClient = await trackClient(await connectMcpClient(server));

    const teamATask = await createTaskViaMcp(clientA, "Team A card");
    const teamBTask = await createTaskViaMcp(clientB, "Team B card");
    const manualTask = await createTaskViaMcp(manualClient, "Manual card");

    const ports = createTestDeletionPorts(system);
    const result = await deleteTeamRun(ports, "team-a-root", "ws-1");
    expect(result.deleted.kanbanCards).toBe(1);

    // Team B's card keeps its own owner; the manual card stays unowned.
    const survivors = await system.taskStore.listByWorkspace("ws-1");
    expect(survivors.map((task) => task.id)).toContain(teamBTask.taskId);
    expect(survivors.map((task) => task.id)).toContain(manualTask.taskId);
    expect(survivors.map((task) => task.id)).not.toContain(teamATask.taskId);
    expect(
      survivors.find((task) => task.id === teamBTask.taskId)?.teamRunId,
    ).toBe("team-b-root");
    expect(
      survivors.find((task) => task.id === manualTask.taskId)?.teamRunId,
    ).toBeUndefined();
  });
});
