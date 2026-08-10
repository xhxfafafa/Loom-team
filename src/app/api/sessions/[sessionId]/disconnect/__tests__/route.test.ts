import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  hydrateFromDb,
  getSession,
  proxyRequestToRunner,
  getRequiredRunnerUrl,
  isForwardedAcpRequest,
  finalizeSessionRuntime,
} = vi.hoisted(() => ({
  hydrateFromDb: vi.fn(),
  getSession: vi.fn(),
  proxyRequestToRunner: vi.fn(),
  getRequiredRunnerUrl: vi.fn(),
  isForwardedAcpRequest: vi.fn(),
  finalizeSessionRuntime: vi.fn(),
}));

vi.mock("@/core/acp/http-session-store", () => ({
  getHttpSessionStore: () => ({
    hydrateFromDb,
    getSession,
  }),
}));

vi.mock("@/core/acp/session-runtime-finalizer", () => ({
  finalizeSessionRuntime,
}));

vi.mock("@/core/acp/runner-routing", () => ({
  getRequiredRunnerUrl,
  isForwardedAcpRequest,
  proxyRequestToRunner,
  runnerUnavailableResponse: () => new Response(JSON.stringify({ error: "runner unavailable" }), { status: 503 }),
}));

import { POST } from "../route";

describe("/api/sessions/[sessionId]/disconnect POST", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hydrateFromDb.mockResolvedValue(undefined);
    getRequiredRunnerUrl.mockReturnValue("http://runner.internal");
    isForwardedAcpRequest.mockReturnValue(false);
    proxyRequestToRunner.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    finalizeSessionRuntime.mockResolvedValue({
      sessionId: "session-123",
      reason: "disconnect",
      released: true,
      process: {
        sessionId: "session-123",
        killed: true,
        runtimeKind: "claude-process",
        mcpCleaned: true,
        errors: [],
      },
      errors: [],
    });
  });

  it("proxies runner-owned sessions instead of killing local state", async () => {
    getSession.mockReturnValue({
      sessionId: "session-123",
      cwd: "/tmp/project",
      workspaceId: "workspace-1",
      executionMode: "runner",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/sessions/session-123/disconnect", { method: "POST" }),
      { params: Promise.resolve({ sessionId: "session-123" }) },
    );

    expect(response.status).toBe(200);
    expect(proxyRequestToRunner).toHaveBeenCalledTimes(1);
    expect(finalizeSessionRuntime).not.toHaveBeenCalled();
  });

  it("returns 404 when the session is unknown", async () => {
    getSession.mockReturnValue(undefined);

    const response = await POST(
      new NextRequest("http://localhost/api/sessions/missing/disconnect", { method: "POST" }),
      { params: Promise.resolve({ sessionId: "missing" }) },
    );

    expect(response.status).toBe(404);
    expect(finalizeSessionRuntime).not.toHaveBeenCalled();
  });

  it("routes embedded disconnects through the unified runtime finalizer", async () => {
    getSession.mockReturnValue({
      sessionId: "session-123",
      cwd: "/tmp/project",
      workspaceId: "workspace-1",
      executionMode: "embedded",
    });

    const response = await POST(
      new NextRequest("http://localhost/api/sessions/session-123/disconnect", { method: "POST" }),
      { params: Promise.resolve({ sessionId: "session-123" }) },
    );

    expect(finalizeSessionRuntime).toHaveBeenCalledWith("session-123", "disconnect");
    expect(await response.json()).toEqual({
      ok: true,
      runtime: { released: true, processTerminated: true, errors: [] },
    });
  });
});
