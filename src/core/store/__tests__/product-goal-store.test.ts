import { describe, expect, it, beforeEach } from "vitest";
import { InMemoryProductGoalStore } from "@/core/store/product-goal-store";
import { createProductGoal } from "@/core/models/product-goal";

describe("InMemoryProductGoalStore", () => {
  let store: InMemoryProductGoalStore;

  beforeEach(() => {
    store = new InMemoryProductGoalStore();
  });

  it("saves and retrieves a goal", async () => {
    const goal = createProductGoal({
      id: "goal-1",
      workspaceId: "ws-1",
      goalText: "Build a REST API",
    });

    await store.save(goal);
    const retrieved = await store.get("goal-1");

    expect(retrieved).toBeDefined();
    expect(retrieved?.goalText).toBe("Build a REST API");
    expect(retrieved?.workspaceId).toBe("ws-1");
    expect(retrieved?.status).toBe("draft");
    expect(retrieved?.repos).toEqual([]);
    expect(retrieved?.requirementDocs).toEqual([]);
    expect(retrieved?.constraints).toEqual([]);
  });

  it("returns undefined for non-existent goal", async () => {
    const result = await store.get("non-existent");
    expect(result).toBeUndefined();
  });

  it("lists goals by workspace", async () => {
    await store.save(createProductGoal({ id: "g1", workspaceId: "ws-1", goalText: "Goal 1" }));
    await store.save(createProductGoal({ id: "g2", workspaceId: "ws-1", goalText: "Goal 2" }));
    await store.save(createProductGoal({ id: "g3", workspaceId: "ws-2", goalText: "Goal 3" }));

    const ws1Goals = await store.listByWorkspace("ws-1");
    expect(ws1Goals).toHaveLength(2);

    const ws2Goals = await store.listByWorkspace("ws-2");
    expect(ws2Goals).toHaveLength(1);
    expect(ws2Goals[0].goalText).toBe("Goal 3");
  });

  it("updates goal status", async () => {
    await store.save(createProductGoal({ id: "g1", workspaceId: "ws-1", goalText: "Goal" }));

    await store.updateStatus("g1", "active");
    const updated = await store.get("g1");
    expect(updated?.status).toBe("active");
  });

  it("deletes a goal", async () => {
    await store.save(createProductGoal({ id: "g1", workspaceId: "ws-1", goalText: "Goal" }));
    await store.delete("g1");

    const result = await store.get("g1");
    expect(result).toBeUndefined();
  });

  it("preserves structured fields", async () => {
    const goal = createProductGoal({
      id: "g1",
      workspaceId: "ws-1",
      goalText: "Build feature X",
      repos: [
        { kind: "local", path: "/home/user/project" },
        { kind: "github", url: "https://github.com/org/repo" },
      ],
      requirementDocs: [{ name: "PRD", content: "Product requirements..." }],
      constraints: ["Must use PostgreSQL", "Max 100ms latency"],
    });

    await store.save(goal);
    const retrieved = await store.get("g1");

    expect(retrieved?.repos).toHaveLength(2);
    expect(retrieved?.repos[0].kind).toBe("local");
    expect(retrieved?.repos[1].kind).toBe("github");
    expect(retrieved?.requirementDocs).toHaveLength(1);
    expect(retrieved?.requirementDocs[0].name).toBe("PRD");
    expect(retrieved?.constraints).toHaveLength(2);
  });
});
