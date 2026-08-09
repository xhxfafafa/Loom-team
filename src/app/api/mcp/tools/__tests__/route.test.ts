import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServer, executeTool } = vi.hoisted(() => ({
  createServer: vi.fn(),
  executeTool: vi.fn(),
}));

vi.mock("@/core/mcp/routa-mcp-server", () => ({
  createRoutaMcpServer: createServer,
}));

vi.mock("@/core/mcp/mcp-tool-executor", () => ({
  executeMcpTool: executeTool,
  getMcpToolDefinitions: () => [{ name: "create_card" }],
}));

vi.mock("@/core/tools/kanban-tools", () => ({
  KanbanTools: class {
    setEventBus() {}
    setAutomationSystem() {}
  },
}));

vi.mock("@/core/mcp/tool-mode-config", () => ({
  getGlobalToolMode: () => "essential",
  setGlobalToolMode: vi.fn(),
}));

vi.mock("@/core/mcp/mcp-server-profiles", () => ({
  resolveMcpServerProfile: () => undefined,
}));

import { POST } from "../route";

beforeEach(() => {
  createServer.mockReturnValue({
    system: {
      tools: {},
      noteTools: {},
      workspaceTools: {},
      kanbanBoardStore: {},
      taskStore: {},
      eventBus: {},
    },
  });
  executeTool.mockResolvedValue({ ok: true });
});

describe("POST /api/mcp/tools", () => {
  it("propagates the ACP session to direct MCP execution", async () => {
    const response = await POST(new NextRequest("http://localhost/api/mcp/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "create_card",
        workspaceId: "ws-1",
        sessionId: "team-child",
        args: { workspaceId: "ws-1" },
      }),
    }));

    expect(response.status).toBe(200);
    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      sessionId: "team-child",
    }));
    expect(executeTool).toHaveBeenCalledWith(
      expect.anything(),
      "create_card",
      expect.objectContaining({ sessionId: "team-child" }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it("uses the session header when the body does not repeat it", async () => {
    await POST(new NextRequest("http://localhost/api/mcp/tools", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "routa-session-id": "team-root",
      },
      body: JSON.stringify({
        name: "create_card",
        workspaceId: "ws-1",
        args: { workspaceId: "ws-1" },
      }),
    }));

    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "team-root",
    }));
  });
});
