import { describe, expect, it } from "vitest";

import { AgentEventType, EventBus } from "../event-bus";

describe("EventBus.removeAgentData", () => {
  it("clears pending events and removes subscriptions owned by a deleted agent", () => {
    const bus = new EventBus();
    bus.subscribe({
      id: "subscription-1",
      agentId: "agent-1",
      agentName: "Deleted agent",
      eventTypes: [AgentEventType.AGENT_COMPLETED],
      excludeSelf: false,
    });

    bus.emit({
      type: AgentEventType.AGENT_COMPLETED,
      agentId: "agent-2",
      workspaceId: "workspace-1",
      data: {},
      timestamp: new Date(),
    });
    bus.removeAgentData("agent-1");

    bus.emit({
      type: AgentEventType.AGENT_COMPLETED,
      agentId: "agent-2",
      workspaceId: "workspace-1",
      data: {},
      timestamp: new Date(),
    });

    expect(bus.drainPendingEvents("agent-1")).toEqual([]);
  });
});
