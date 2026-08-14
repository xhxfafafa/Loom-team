// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { getKanbanEventBroadcaster } from "@/core/kanban/kanban-event-broadcaster";
import { GET } from "../route";

/**
 * Kanban SSE endpoint wiring: mutation routes never push to clients
 * directly — they notify the process-wide broadcaster, and this route is
 * the only delivery surface. These tests pin the attach → deliver → detach
 * lifecycle end-to-end through the real broadcaster singleton (events are
 * ephemeral; there is no kanban_events table).
 */

function callEvents(params = "") {
  return GET(new NextRequest(`http://localhost/api/kanban/events${params}`));
}

function decode(value: Uint8Array | undefined): string {
  return value ? new TextDecoder().decode(value) : "";
}

describe("GET /api/kanban/events", () => {
  it("responds with SSE headers", async () => {
    const response = await callEvents("?workspaceId=workspace-a");

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    await response.body?.cancel();
  });

  it("sends the connected handshake then delivers events broadcast for that workspace", async () => {
    const broadcaster = getKanbanEventBroadcaster();
    const response = await callEvents("?workspaceId=workspace-sse");
    const reader = response.body!.getReader();

    try {
      const handshake = decode((await reader.read()).value);
      expect(handshake).toContain("\"type\":\"connected\"");
      expect(handshake).toContain("\"workspaceId\":\"workspace-sse\"");

      broadcaster.notify({
        workspaceId: "workspace-sse",
        entity: "board",
        action: "created",
        resourceId: "board-sse",
        source: "user",
      });
      broadcaster.notify({
        workspaceId: "workspace-other",
        entity: "task",
        action: "moved",
        resourceId: "task-other",
        source: "user",
      });

      const delivered = decode((await reader.read()).value);
      expect(delivered).toContain("\"type\":\"kanban:changed\"");
      expect(delivered).toContain("\"resourceId\":\"board-sse\"");
      expect(delivered).not.toContain("workspace-other");
    } finally {
      await reader.cancel();
    }
  });

  it("defaults to the wildcard workspace when workspaceId is missing", async () => {
    const broadcaster = getKanbanEventBroadcaster();
    const response = await callEvents();
    const reader = response.body!.getReader();

    try {
      const handshake = decode((await reader.read()).value);
      expect(handshake).toContain("\"workspaceId\":\"*\"");

      broadcaster.notify({
        workspaceId: "workspace-any",
        entity: "queue",
        action: "refreshed",
        source: "system",
      });

      const delivered = decode((await reader.read()).value);
      expect(delivered).toContain("\"workspaceId\":\"workspace-any\"");
      expect(delivered).toContain("\"entity\":\"queue\"");
    } finally {
      await reader.cancel();
    }
  });

  it("detaches from the broadcaster when the client disconnects", async () => {
    const broadcaster = getKanbanEventBroadcaster();
    const before = broadcaster.connectionCount;

    const response = await callEvents("?workspaceId=workspace-detach");
    expect(broadcaster.connectionCount).toBe(before + 1);

    await response.body?.cancel();
    expect(broadcaster.connectionCount).toBe(before);
  });
});
