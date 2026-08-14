import { describe, expect, it } from "vitest";
import { KanbanEventBroadcaster, getKanbanEventBroadcaster } from "../kanban-event-broadcaster";

function createController() {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const controller = {
    enqueue(value: Uint8Array) {
      chunks.push(decoder.decode(value));
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return { controller, chunks };
}

function createControllerThatDiesAfterFirstFrame() {
  let delivered = 0;
  const controller = {
    enqueue() {
      delivered += 1;
      if (delivered > 1) {
        // The handshake succeeds; every later write fails like a closed socket.
        throw new Error("connection closed");
      }
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return { controller };
}

function parseFrames(chunks: string[]): Array<Record<string, unknown>> {
  return chunks
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.replace(/^data: /, "").trim()) as Record<string, unknown>);
}

describe("KanbanEventBroadcaster", () => {
  it("broadcasts only to subscribers in the matching workspace", () => {
    const broadcaster = new KanbanEventBroadcaster();
    const workspaceA = createController();
    const workspaceB = createController();

    broadcaster.attach("workspace-a", workspaceA.controller);
    broadcaster.attach("workspace-b", workspaceB.controller);

    broadcaster.notify({
      workspaceId: "workspace-a",
      entity: "task",
      action: "moved",
      resourceId: "task-1",
      source: "agent",
    });

    expect(workspaceA.chunks.some((chunk) => chunk.includes("\"workspaceId\":\"workspace-a\""))).toBe(true);
    expect(workspaceA.chunks.some((chunk) => chunk.includes("\"action\":\"moved\""))).toBe(true);
    expect(workspaceB.chunks.some((chunk) => chunk.includes("\"action\":\"moved\""))).toBe(false);
  });

  it("sends a connected handshake frame on attach", () => {
    const broadcaster = new KanbanEventBroadcaster();
    const subscriber = createController();

    const connectionId = broadcaster.attach("workspace-a", subscriber.controller);

    const frames = parseFrames(subscriber.chunks);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "connected",
      connectionId,
      workspaceId: "workspace-a",
    });
    expect(typeof frames[0]?.timestamp).toBe("string");
  });

  it("stops delivering after detach and tracks connectionCount", () => {
    const broadcaster = new KanbanEventBroadcaster();
    const subscriber = createController();

    const connectionId = broadcaster.attach("workspace-a", subscriber.controller);
    expect(broadcaster.connectionCount).toBe(1);

    broadcaster.detach(connectionId);
    expect(broadcaster.connectionCount).toBe(0);

    broadcaster.notify({
      workspaceId: "workspace-a",
      entity: "board",
      action: "created",
      resourceId: "board-1",
      source: "user",
    });

    // Only the handshake frame, nothing after detach.
    expect(parseFrames(subscriber.chunks)).toHaveLength(1);
  });

  it("prunes dead connections whose enqueue throws", () => {
    const broadcaster = new KanbanEventBroadcaster();
    const alive = createController();
    const dead = createControllerThatDiesAfterFirstFrame();

    broadcaster.attach("workspace-a", alive.controller);
    broadcaster.attach("workspace-a", dead.controller);
    expect(broadcaster.connectionCount).toBe(2);

    broadcaster.notify({
      workspaceId: "workspace-a",
      entity: "task",
      action: "updated",
      resourceId: "task-1",
      source: "system",
    });

    // The dead connection is removed during the failing broadcast while the
    // alive subscriber keeps receiving.
    expect(broadcaster.connectionCount).toBe(1);
    expect(alive.chunks.some((chunk) => chunk.includes("\"action\":\"updated\""))).toBe(true);
  });

  it("delivers wildcard subscribers every workspace event", () => {
    const broadcaster = new KanbanEventBroadcaster();
    const wildcard = createController();

    broadcaster.attach("*", wildcard.controller);

    broadcaster.notify({
      workspaceId: "workspace-a",
      entity: "task",
      action: "created",
      resourceId: "task-1",
      source: "user",
    });
    broadcaster.notify({
      workspaceId: "workspace-b",
      entity: "board",
      action: "deleted",
      resourceId: "board-1",
      source: "user",
    });

    const frames = parseFrames(wildcard.chunks);
    const events = frames.filter((frame) => frame.type === "kanban:changed");
    expect(events.map((frame) => frame.workspaceId)).toEqual(["workspace-a", "workspace-b"]);
  });

  it("stamps kanban:changed type and timestamp on notify", () => {
    const broadcaster = new KanbanEventBroadcaster();
    const subscriber = createController();
    broadcaster.attach("workspace-a", subscriber.controller);

    broadcaster.notify({
      workspaceId: "workspace-a",
      entity: "column",
      action: "refreshed",
      source: "system",
    });

    const frames = parseFrames(subscriber.chunks);
    const event = frames.find((frame) => frame.type === "kanban:changed");
    expect(event).toMatchObject({
      type: "kanban:changed",
      workspaceId: "workspace-a",
      entity: "column",
      action: "refreshed",
      source: "system",
    });
    expect(Number.isNaN(Date.parse(String(event?.timestamp)))).toBe(false);
  });

  it("stamps fitness:changed type on notifyFitness", () => {
    const broadcaster = new KanbanEventBroadcaster();
    const subscriber = createController();
    broadcaster.attach("workspace-a", subscriber.controller);

    broadcaster.notifyFitness({
      workspaceId: "workspace-a",
      source: "agent",
      repoPath: "/tmp/repo",
    });

    const frames = parseFrames(subscriber.chunks);
    const event = frames.find((frame) => frame.type === "fitness:changed");
    expect(event).toMatchObject({
      type: "fitness:changed",
      workspaceId: "workspace-a",
      source: "agent",
      repoPath: "/tmp/repo",
    });
  });

  it("exposes a process-wide singleton via getKanbanEventBroadcaster", () => {
    const first = getKanbanEventBroadcaster();
    const second = getKanbanEventBroadcaster();
    expect(second).toBe(first);
  });
});
