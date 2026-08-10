import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionStoreMemoryUsage, cleanupSessionRuntimesForMemory } = vi.hoisted(() => ({
  getSessionStoreMemoryUsage: vi.fn(),
  cleanupSessionRuntimesForMemory: vi.fn(),
}));

vi.mock("@/core/acp/http-session-store", () => ({
  getSessionStoreMemoryUsage,
}));

vi.mock("@/core/acp/session-runtime-finalizer", () => ({
  cleanupSessionRuntimesForMemory,
}));

import { DELETE, GET, POST } from "../route";

describe("/api/system/memory runtime-aware cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionStoreMemoryUsage.mockReturnValue({
      sessionCount: 3,
      activeSseCount: 0,
      streamingCount: 0,
      totalHistoryMessages: 12,
      totalPendingNotifications: 0,
      historyBySession: {},
      staleSessionCount: 1,
    });
    cleanupSessionRuntimesForMemory.mockResolvedValue({
      sessionsRemoved: 2,
      agentProcessesTerminated: 1,
      mcpProxiesCleaned: 1,
      failures: [{ sessionId: "broken", step: "finalize", error: "killSession failed: boom" }],
    });
  });

  it("POST reports logical removal separately from process and MCP reclamation", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/system/memory", {
        method: "POST",
        body: JSON.stringify({ aggressive: true }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(cleanupSessionRuntimesForMemory).toHaveBeenCalledWith({ aggressive: true });
    const data = await response.json();
    expect(data.cleanup.sessionStore).toEqual({ sessionsRemoved: 2, remaining: 3 });
    expect(data.cleanup.runtime).toEqual({
      agentProcessesTerminated: 1,
      mcpProxiesCleaned: 1,
      failures: [{ sessionId: "broken", step: "finalize", error: "killSession failed: boom" }],
    });
  });

  it("GET ?cleanup=true includes runtime reclamation counts", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/system/memory?cleanup=true&aggressive=true"),
    );

    const data = await response.json();
    expect(cleanupSessionRuntimesForMemory).toHaveBeenCalledWith({ aggressive: true });
    expect(data.cleanup).toMatchObject({
      sessionsRemoved: 2,
      agentProcessesTerminated: 1,
      mcpProxiesCleaned: 1,
    });
    expect(data.cleanup.failures).toHaveLength(1);
  });

  it("GET without cleanup does not reclaim anything", async () => {
    await GET(new NextRequest("http://localhost/api/system/memory"));
    expect(cleanupSessionRuntimesForMemory).not.toHaveBeenCalled();
  });

  it("DELETE ?sessions=true reports truthful removal counts", async () => {
    const response = await DELETE(
      new NextRequest("http://localhost/api/system/memory?sessions=true", { method: "DELETE" }),
    );

    const data = await response.json();
    expect(cleanupSessionRuntimesForMemory).toHaveBeenCalledWith({ aggressive: true });
    expect(data.sessionsCleared).toBe(2);
    expect(data.runtime).toMatchObject({ agentProcessesTerminated: 1, mcpProxiesCleaned: 1 });
  });
});
