import { describe, expect, it } from "vitest";
import {
  buildFallbackPlan,
  generateDevPlanContent,
  generateFallbackDevPlanContent,
  type PlanGeneratorLLM,
} from "@/core/plan/dev-plan-generator";
import { safeParseDevPlanContent } from "@/core/plan/dev-plan-schema";
import { createProductGoal } from "@/core/models/product-goal";

const baseGoal = createProductGoal({
  id: "g1",
  workspaceId: "ws-1",
  goalText: "Build a REST API with auth",
  repos: [{ kind: "local", path: "/repo" }],
  requirementDocs: [{ name: "PRD", content: "Detailed requirements…" }],
  constraints: ["Use PostgreSQL", "Max latency 100ms"],
});

describe("buildFallbackPlan", () => {
  it("returns a valid DevPlanContent", () => {
    const content = buildFallbackPlan(baseGoal);
    const result = safeParseDevPlanContent(content);
    expect(result.success).toBe(true);
    expect(content.userStories.length).toBeGreaterThanOrEqual(2);
    expect(content.scope.length).toBeGreaterThan(0);
    expect(content.risks.every((r) => typeof r.risk === "string")).toBe(true);
    expect(content.teamAllocation.length).toBeGreaterThan(0);
    expect(content.technicalApproach.length).toBeGreaterThan(0);
  });

  it("includes goal text in scope/approach", () => {
    const content = buildFallbackPlan(baseGoal);
    expect(content.scope.some((s) => s.includes(baseGoal.goalText))).toBe(true);
    expect(content.technicalApproach).toContain(baseGoal.goalText);
  });
});

describe("safeParseDevPlanContent", () => {
  it("rejects malformed input", () => {
    const result = safeParseDevPlanContent({ scope: "not-an-array" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("scope");
  });

  it("rejects missing required fields", () => {
    const result = safeParseDevPlanContent({
      scope: [],
      nonGoals: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed payload", () => {
    const result = safeParseDevPlanContent({
      scope: ["S1"],
      nonGoals: ["NG1"],
      risks: [{ risk: "R" }],
      userStories: [
        { id: "US-1", title: "T", story: "S", acceptanceCriteria: ["AC"] },
      ],
      technicalApproach: "TA",
      teamAllocation: [{ role: "r", responsibility: "resp" }],
    });
    expect(result.success).toBe(true);
  });
});

describe("generateDevPlanContent", () => {
  it("uses LLM output when valid", async () => {
    const llm: PlanGeneratorLLM = {
      generate: async () =>
        JSON.stringify({
          scope: ["LLM scope"],
          nonGoals: ["LLM non-goal"],
          risks: [{ risk: "LLM risk", mitigation: "LLM mitigation" }],
          userStories: [
            {
              id: "US-1",
              title: "LLM story",
              story: "Story",
              acceptanceCriteria: ["AC1"],
            },
          ],
          technicalApproach: "LLM approach",
          teamAllocation: [{ role: "LLM role", responsibility: "LLM resp" }],
        }),
    };

    const result = await generateDevPlanContent({ goal: baseGoal, llm });
    expect(result.source).toBe("llm");
    expect(result.content.scope).toEqual(["LLM scope"]);
    expect(result.content.userStories[0].title).toBe("LLM story");
  });

  it("falls back when LLM throws", async () => {
    const llm: PlanGeneratorLLM = {
      generate: async () => {
        throw new Error("API key missing");
      },
    };
    const result = await generateDevPlanContent({ goal: baseGoal, llm });
    expect(result.source).toBe("fallback");
    expect(result.fallbackReason).toContain("API key missing");
    expect(result.content.userStories.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back when LLM returns invalid JSON", async () => {
    const llm: PlanGeneratorLLM = {
      generate: async () => "definitely not json",
    };
    const result = await generateDevPlanContent({ goal: baseGoal, llm });
    expect(result.source).toBe("fallback");
    expect(result.fallbackReason).toMatch(/JSON|schema/);
  });

  it("falls back when LLM returns structurally wrong JSON", async () => {
    const llm: PlanGeneratorLLM = {
      generate: async () => JSON.stringify({ scope: "not-an-array" }),
    };
    const result = await generateDevPlanContent({ goal: baseGoal, llm });
    expect(result.source).toBe("fallback");
    expect(result.fallbackReason).toContain("schema");
  });

  it("strips markdown fences around JSON", async () => {
    const llm: PlanGeneratorLLM = {
      generate: async () =>
        '```json\n' +
        JSON.stringify({
          scope: ["s"],
          nonGoals: [],
          risks: [],
          userStories: [
            { id: "US-1", title: "t", story: "s", acceptanceCriteria: [] },
          ],
          technicalApproach: "ta",
          teamAllocation: [],
        }) +
        "\n```",
    };
    const result = await generateDevPlanContent({ goal: baseGoal, llm });
    expect(result.source).toBe("llm");
    expect(result.content.scope).toEqual(["s"]);
  });

  it("synchronous helper returns fallback", () => {
    const result = generateFallbackDevPlanContent(baseGoal);
    expect(result.source).toBe("fallback");
    expect(result.content.userStories.length).toBeGreaterThan(0);
  });
});
