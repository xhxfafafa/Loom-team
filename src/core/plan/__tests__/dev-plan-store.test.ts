import { describe, expect, it, beforeEach } from "vitest";
import { InMemoryDevPlanStore } from "@/core/plan/dev-plan-store";
import { createDevPlan } from "@/core/plan/dev-plan";

function samplePlan(overrides: Partial<ReturnType<typeof createDevPlan>> = {}) {
  return createDevPlan({
    id: "plan-1",
    workspaceId: "ws-1",
    goalId: "goal-1",
    scope: ["Implement feature X"],
    nonGoals: ["Unrelated refactors"],
    risks: [{ risk: "Risk A", mitigation: "Mitigation A" }],
    userStories: [
      {
        id: "US-1",
        title: "Feature X",
        story: "As a user, I want X so that Y.",
        acceptanceCriteria: ["AC 1", "AC 2"],
      },
    ],
    technicalApproach: "Vertical slice first",
    teamAllocation: [{ role: "CRAFTER", responsibility: "Implement" }],
    ...overrides,
  });
}

describe("InMemoryDevPlanStore", () => {
  let store: InMemoryDevPlanStore;

  beforeEach(() => {
    store = new InMemoryDevPlanStore();
  });

  it("saves and retrieves a plan", async () => {
    const plan = samplePlan();
    await store.save(plan);
    const got = await store.get("plan-1");

    expect(got).toBeDefined();
    expect(got?.workspaceId).toBe("ws-1");
    expect(got?.goalId).toBe("goal-1");
    expect(got?.status).toBe("draft");
    expect(got?.scope).toEqual(["Implement feature X"]);
    expect(got?.risks).toHaveLength(1);
    expect(got?.userStories).toHaveLength(1);
    expect(got?.userStories[0].acceptanceCriteria).toEqual(["AC 1", "AC 2"]);
  });

  it("returns undefined for non-existent plan", async () => {
    expect(await store.get("nope")).toBeUndefined();
  });

  it("lists plans by workspace", async () => {
    await store.save(samplePlan({ id: "p1", workspaceId: "ws-1" }));
    await store.save(samplePlan({ id: "p2", workspaceId: "ws-1" }));
    await store.save(samplePlan({ id: "p3", workspaceId: "ws-2" }));

    const ws1 = await store.listByWorkspace("ws-1");
    expect(ws1).toHaveLength(2);

    const ws2 = await store.listByWorkspace("ws-2");
    expect(ws2).toHaveLength(1);
  });

  it("lists plans by goal", async () => {
    await store.save(samplePlan({ id: "p1", goalId: "g1" }));
    await store.save(samplePlan({ id: "p2", goalId: "g1" }));
    await store.save(samplePlan({ id: "p3", goalId: "g2" }));

    const g1 = await store.listByGoal("g1");
    expect(g1).toHaveLength(2);
  });

  it("updates status to confirmed with confirmedAt", async () => {
    await store.save(samplePlan());
    const confirmedAt = new Date().toISOString();
    await store.updateStatus("plan-1", "confirmed", { confirmedAt });

    const got = await store.get("plan-1");
    expect(got?.status).toBe("confirmed");
    expect(got?.confirmedAt).toBe(confirmedAt);
  });

  it("updates status to rejected and appends feedback", async () => {
    await store.save(samplePlan());
    await store.updateStatus("plan-1", "rejected", {
      feedbackEntry: { at: "2026-01-01T00:00:00Z", note: "Not enough detail" },
    });

    const got = await store.get("plan-1");
    expect(got?.status).toBe("rejected");
    expect(got?.feedbackLog).toHaveLength(1);
    expect(got?.feedbackLog[0].note).toBe("Not enough detail");
  });

  it("deletes a plan", async () => {
    await store.save(samplePlan());
    await store.delete("plan-1");
    expect(await store.get("plan-1")).toBeUndefined();
  });
});
