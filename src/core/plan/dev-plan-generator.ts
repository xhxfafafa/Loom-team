/**
 * DevPlan Generator
 *
 * Produces a structured DevPlan content payload from a ProductGoal.
 *
 * Two generation paths share the same validation:
 *   1. LLM path — uses the existing Vercel AI SDK + createLanguageModel
 *      infrastructure from src/core/acp/workspace-agent/workspace-agent-config.ts.
 *   2. Deterministic fallback — a template-based skeleton derived from the
 *      goal fields. Used whenever no LLM is reachable (no API keys, model
 *      unavailable, parse failures).
 *
 * Both paths return a DevPlanContent validated by parseDevPlanContent so the
 * API layer never sees a malformed plan.
 */

import type { ProductGoal } from "../models/product-goal";
import {
  parseDevPlanContent,
  safeParseDevPlanContent,
  type DevPlanContent,
} from "./dev-plan-schema";

/**
 * Small abstraction over the LLM call. The default implementation uses
 * createLanguageModel + generateText; tests / offline environments can swap
 * in a deterministic implementation.
 */
export interface PlanGeneratorLLM {
  generate(prompt: string): Promise<string>;
}

/**
 * Default LLM adapter — uses the workspace agent config. Imported lazily so
 * server-only modules don't leak into the browser bundle.
 */
class DefaultPlanLLM implements PlanGeneratorLLM {
  async generate(prompt: string): Promise<string> {
    const { createLanguageModel, resolveWorkspaceAgentConfig } = await import(
      "../acp/workspace-agent/workspace-agent-config"
    );
    const { generateText } = await import("ai");
    const config = resolveWorkspaceAgentConfig({ maxSteps: 1, maxTokens: 8_192 });
    const model = await createLanguageModel(config);
    const result = await generateText({
      model,
      prompt,
    });
    return result.text;
  }
}

// ─── Prompt ──────────────────────────────────────────────────────────

function buildPlanPrompt(goal: ProductGoal, feedback?: string): string {
  const goalLines = [
    `Product goal: ${goal.goalText}`,
    goal.repos.length
      ? `Repositories: ${goal.repos.map((r) => r.path ?? r.url ?? "unknown").join(", ")}`
      : null,
    goal.requirementDocs.length
      ? `Requirement docs:\n${goal.requirementDocs
          .map((d) => `  - ${d.name}: ${d.content.slice(0, 400)}`)
          .join("\n")}`
      : null,
    goal.constraints.length
      ? `Constraints: ${goal.constraints.join("; ")}`
      : null,
    feedback ? `User feedback to incorporate (previous plan was rejected):\n${feedback}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  return `You are a senior product engineer creating a structured product development plan.

${goalLines}

Return ONLY a single JSON object (no markdown fences, no commentary) with this exact shape:
{
  "scope": ["<in-scope deliverable 1>", "..."],
  "nonGoals": ["<explicitly out of scope 1>", "..."],
  "risks": [{ "risk": "<risk description>", "mitigation": "<mitigation>" }],
  "userStories": [
    {
      "id": "US-1",
      "title": "<short title>",
      "story": "As a <role>, I want <capability> so that <value>.",
      "acceptanceCriteria": ["<criterion 1>", "..."]
    }
  ],
  "technicalApproach": "<1-3 paragraph technical approach>",
  "teamAllocation": [{ "role": "<role>", "responsibility": "<responsibility>" }]
}

Rules:
- Produce 2-6 user stories with 2-5 acceptance criteria each.
- Every risk must have a mitigation.
- Team allocation should reflect realistic roles needed for the goal.
- If feedback is provided above, adjust scope/stories accordingly; do not repeat rejected decisions.
- Output MUST be valid JSON and nothing else.`;
}

// ─── Fallback ────────────────────────────────────────────────────────

export function buildFallbackPlan(goal: ProductGoal): DevPlanContent {
  const repoLabel = goal.repos.length
    ? goal.repos.map((r) => r.path ?? r.url ?? "repository").join(", ")
    : "the target repository";

  const scope = [
    `Implement the core functionality described in the goal: ${goal.goalText}`,
    goal.requirementDocs.length
      ? `Incorporate requirements from: ${goal.requirementDocs.map((d) => d.name).join(", ")}`
      : `Define minimal MVP surface for ${goal.goalText}`,
    `Write tests and documentation for the implemented features`,
  ];

  const nonGoals = [
    "Unrelated refactors not required for the goal",
    "Features not explicitly listed in scope",
  ];

  const risks = [
    {
      risk: "Requirements may be ambiguous or incomplete",
      mitigation: "Clarify with stakeholder before implementation begins",
    },
    {
      risk: "Integration with existing systems may surface unknown issues",
      mitigation: `Spike against ${repoLabel} early; reserve buffer for fixes`,
    },
  ];
  if (goal.constraints.length) {
    risks.push({
      risk: `Constraints may limit solution space: ${goal.constraints.join("; ")}`,
      mitigation: "Validate constraint assumptions with the team up front",
    });
  }

  const userStories = [
    {
      id: "US-1",
      title: `Deliver ${goal.goalText}`,
      story: `As a user, I want ${goal.goalText} so that the product meets the stated objective.`,
      acceptanceCriteria: [
        "Core functionality works end-to-end",
        "Relevant existing tests still pass",
        "Acceptance criteria from the spec are satisfied",
      ],
    },
    {
      id: "US-2",
      title: "Verify and document the implementation",
      story: "As a reviewer, I want tests and documentation so that I can verify correctness.",
      acceptanceCriteria: [
        "Automated tests cover the happy path",
        "Public APIs are documented",
        "README or equivalent is updated where user-facing",
      ],
    },
  ];

  const technicalApproach =
    `Approach: deliver ${goal.goalText} incrementally. Start with a small vertical ` +
    `slice that exercises the primary flow in ${repoLabel}, add automated tests, ` +
    `then broaden to remaining stories. ` +
    (goal.constraints.length
      ? `Constraints to respect: ${goal.constraints.join("; ")}. `
      : "") +
    `Keep changes focused and avoid cross-cutting refactors unless required.`;

  const teamAllocation = [
    {
      role: "Implementor (CRAFTER)",
      responsibility: "Implement stories, write tests, iterate on feedback",
    },
    {
      role: "Reviewer (GATE)",
      responsibility: "Verify acceptance criteria and automated checks",
    },
    {
      role: "Coordinator (ROUTA)",
      responsibility: "Plan, delegate, and track progress",
    },
  ];

  return {
    scope,
    nonGoals,
    risks,
    userStories,
    technicalApproach,
    teamAllocation,
  };
}

// ─── Extract JSON from LLM output ────────────────────────────────────

function extractJsonFromLLM(text: string): unknown {
  const trimmed = text.trim();
  // Strip optional markdown fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  return JSON.parse(candidate);
}

// ─── Public entry point ──────────────────────────────────────────────

export interface GeneratePlanOptions {
  goal: ProductGoal;
  /** Optional previous-rejection feedback to fold in */
  feedback?: string;
  /** Optional LLM override for tests / deterministic environments */
  llm?: PlanGeneratorLLM;
}

export interface GeneratePlanResult {
  content: DevPlanContent;
  /** "llm" | "fallback" — which path produced the plan */
  source: "llm" | "fallback";
  /** Diagnostic message when fallback was used */
  fallbackReason?: string;
}

/**
 * Generate a plan. Always returns a validated DevPlanContent. Falls back
 * to the deterministic template whenever the LLM path is unavailable or
 * returns invalid output.
 */
export async function generateDevPlanContent(
  options: GeneratePlanOptions,
): Promise<GeneratePlanResult> {
  const llm = options.llm ?? new DefaultPlanLLM();
  const prompt = buildPlanPrompt(options.goal, options.feedback);

  let raw: string;
  try {
    raw = await llm.generate(prompt);
  } catch (err) {
    return {
      content: buildFallbackPlan(options.goal),
      source: "fallback",
      fallbackReason: `LLM generate failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = extractJsonFromLLM(raw);
  } catch (err) {
    return {
      content: buildFallbackPlan(options.goal),
      source: "fallback",
      fallbackReason: `LLM output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = safeParseDevPlanContent(parsed);
  if (!result.success || !result.data) {
    return {
      content: buildFallbackPlan(options.goal),
      source: "fallback",
      fallbackReason: `LLM output failed schema validation: ${result.error}`,
    };
  }

  return { content: result.data, source: "llm" };
}

/**
 * Synchronous convenience helper that returns the fallback plan. Useful for
 * tests and for environments where no LLM is configured.
 */
export function generateFallbackDevPlanContent(goal: ProductGoal): GeneratePlanResult {
  return {
    content: buildFallbackPlan(goal),
    source: "fallback",
  };
}

// Re-export parse helpers for consumers.
export { parseDevPlanContent };
