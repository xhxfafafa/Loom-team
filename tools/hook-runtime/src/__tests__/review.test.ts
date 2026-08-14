import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runCommandMock = vi.hoisted(() => vi.fn());
const runReviewTriggerSpecialistMock = vi.hoisted(() => vi.fn());
const loadCodeownersRulesMock = vi.hoisted(() => vi.fn());
const resolveOwnershipMock = vi.hoisted(() => vi.fn());
const buildOwnershipRoutingContextMock = vi.hoisted(() => vi.fn());
const loadReviewTriggerRulesMock = vi.hoisted(() => vi.fn());
const evaluateReviewTriggersMock = vi.hoisted(() => vi.fn());

vi.mock("../process.js", () => ({
  runCommand: runCommandMock,
}));

vi.mock("../specialist-review.js", () => ({
  runReviewTriggerSpecialist: runReviewTriggerSpecialistMock,
}));

vi.mock("../../../../src/core/harness/codeowners", () => {
  const mockModule = {
    loadCodeownersRules: loadCodeownersRulesMock,
    resolveOwnership: resolveOwnershipMock,
    buildOwnershipRoutingContext: buildOwnershipRoutingContextMock,
  };

  return {
    ...mockModule,
    default: mockModule,
  };
});

vi.mock("../../../../src/core/harness/review-triggers", () => {
  const mockModule = {
    loadReviewTriggerRules: loadReviewTriggerRulesMock,
    evaluateReviewTriggers: evaluateReviewTriggersMock,
  };

  return {
    ...mockModule,
    default: mockModule,
  };
});

import { runReviewTriggerPhase } from "../review.js";

function emptyEvaluation(overrides: Record<string, unknown> = {}) {
  return {
    blocked: false,
    humanReviewRequired: false,
    advisoryOnly: false,
    stagedReviewRequired: false,
    base: "origin/main...HEAD",
    changedFiles: [],
    diffStats: { fileCount: 0, addedLines: 0, deletedLines: 0 },
    triggers: [],
    ...overrides,
  };
}

describe("runReviewTriggerPhase", () => {
  const originalAllowReviewTriggerPush = process.env.ROUTA_ALLOW_REVIEW_TRIGGER_PUSH;
  const originalAllowReviewUnavailable = process.env.ROUTA_ALLOW_REVIEW_UNAVAILABLE;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Clear environment variables before each test to ensure clean state
    delete process.env.ROUTA_ALLOW_REVIEW_TRIGGER_PUSH;
    delete process.env.ROUTA_ALLOW_REVIEW_UNAVAILABLE;
    loadCodeownersRulesMock.mockResolvedValue({
      codeownersFile: ".github/CODEOWNERS",
      rules: [],
      warnings: [],
    });
    resolveOwnershipMock.mockReturnValue([]);
    buildOwnershipRoutingContextMock.mockReturnValue({
      changedFiles: [],
      touchedOwners: [],
      touchedOwnerGroupsCount: 0,
      unownedChangedFiles: [],
      overlappingChangedFiles: [],
      highRiskUnownedFiles: [],
      crossOwnerTriggers: [],
      triggerCorrelations: [],
    });
    loadReviewTriggerRulesMock.mockResolvedValue({
      relativePath: "docs/fitness/review-triggers.yaml",
      rules: [],
    });
    evaluateReviewTriggersMock.mockReturnValue(emptyEvaluation());
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleLogSpy.mockRestore();

    if (originalAllowReviewTriggerPush === undefined) {
      delete process.env.ROUTA_ALLOW_REVIEW_TRIGGER_PUSH;
    } else {
      process.env.ROUTA_ALLOW_REVIEW_TRIGGER_PUSH = originalAllowReviewTriggerPush;
    }

    if (originalAllowReviewUnavailable === undefined) {
      delete process.env.ROUTA_ALLOW_REVIEW_UNAVAILABLE;
    } else {
      process.env.ROUTA_ALLOW_REVIEW_UNAVAILABLE = originalAllowReviewUnavailable;
    }
  });

  it("passes when no review trigger matches", async () => {
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 0,
        output: `${process.cwd()}\n`,
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR origin/main",
        durationMs: 5,
        exitCode: 0,
        output: "tools/hook-runtime/src/review.ts\n",
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git ls-files --others --exclude-standard",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git diff --numstat",
        durationMs: 10,
        exitCode: 0,
        output: "1\t0\ttools/hook-runtime/src/review.ts\n",
      });

    const result = await runReviewTriggerPhase("jsonl");

    expect(result.allowed).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.base).toBe("origin/main");
    expect(result.triggers).toEqual([]);
    expect(evaluateReviewTriggersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFiles: ["tools/hook-runtime/src/review.ts"],
        diffStats: { fileCount: 1, addedLines: 1, deletedLines: 0 },
      }),
    );
  });

  it("blocks a matched review trigger when the specialist rejects it", async () => {
    delete process.env.ROUTA_ALLOW_REVIEW_TRIGGER_PUSH;
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 0,
        output: `${process.cwd()}\n`,
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR origin/main",
        durationMs: 5,
        exitCode: 0,
        output: "tools/hook-runtime/src/review.ts\n",
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR",
        durationMs: 5,
        exitCode: 0,
        output: "tools/hook-runtime/src/runtime.ts\n",
      })
      .mockResolvedValueOnce({
        command: "git ls-files --others --exclude-standard",
        durationMs: 5,
        exitCode: 0,
        output: "tmp/debug.txt\n",
      })
      .mockResolvedValueOnce({
        command: "git diff --numstat",
        durationMs: 10,
        exitCode: 0,
        output: "10\t2\ttools/hook-runtime/src/review.ts\n",
      });
    evaluateReviewTriggersMock.mockReturnValueOnce(
      emptyEvaluation({
        stagedReviewRequired: true,
        changedFiles: ["tools/hook-runtime/src/review.ts"],
        diffStats: { fileCount: 1, addedLines: 10, deletedLines: 2 },
        triggers: [{
          action: "staged",
          name: "oversized_change",
          severity: "high",
          confidenceThreshold: null,
          fallbackAction: "require_human_review",
          specialistId: null,
          provider: null,
          model: null,
          context: [],
          reviewLayers: [],
          reasons: ["diff touched 1 files (threshold: 12)"],
        }],
      }),
    );
    runReviewTriggerSpecialistMock.mockResolvedValueOnce({
      allowed: false,
      outcome: "block",
      summary: "Automatic review specialist found a regression risk.",
      confidence: 9,
      findings: [{ severity: "high", title: "Regression risk", reason: "Control flow changed without safeguards." }],
      raw: "{\"decision\":\"block\",\"confidence\":9}",
    });
    buildOwnershipRoutingContextMock.mockReturnValueOnce({
      changedFiles: ["tools/hook-runtime/src/review.ts"],
      touchedOwners: ["@platform-team"],
      touchedOwnerGroupsCount: 1,
      unownedChangedFiles: [],
      overlappingChangedFiles: [],
      highRiskUnownedFiles: [],
      crossOwnerTriggers: [],
      triggerCorrelations: [],
    });

    const result = await runReviewTriggerPhase("jsonl");

    expect(result.allowed).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.triggers).toHaveLength(1);
    expect(result.committedFiles).toEqual(["tools/hook-runtime/src/review.ts"]);
    expect(result.workingTreeFiles).toEqual(["tools/hook-runtime/src/runtime.ts"]);
    expect(result.untrackedFiles).toEqual(["tmp/debug.txt"]);
    expect(result.message).toContain("regression risk");
  });

  it("passes advisory-only triggers without invoking the specialist", async () => {
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 0,
        output: `${process.cwd()}\n`,
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR origin/main",
        durationMs: 5,
        exitCode: 0,
        output: "docs/fitness/README.md\n",
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git ls-files --others --exclude-standard",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git diff --numstat",
        durationMs: 10,
        exitCode: 0,
        output: "5\t0\tdocs/fitness/README.md\n",
      });
    evaluateReviewTriggersMock.mockReturnValueOnce(
      emptyEvaluation({
        advisoryOnly: true,
        changedFiles: ["docs/fitness/README.md"],
        diffStats: { fileCount: 1, addedLines: 5, deletedLines: 0 },
        triggers: [{
          action: "advisory",
          name: "docs_change",
          severity: "low",
          confidenceThreshold: null,
          fallbackAction: null,
          specialistId: null,
          provider: null,
          model: null,
          context: [],
          reviewLayers: [],
          reasons: ["changed path: docs/fitness/README.md"],
        }],
      }),
    );

    const result = await runReviewTriggerPhase("jsonl");

    expect(result.allowed).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.message).toContain("Review advisory");
    expect(runReviewTriggerSpecialistMock).not.toHaveBeenCalled();
  });

  it("blocks immediately when a trigger explicitly requires human review", async () => {
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 0,
        output: `${process.cwd()}\n`,
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR origin/main",
        durationMs: 5,
        exitCode: 0,
        output: "api-contract.yaml\n",
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git ls-files --others --exclude-standard",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git diff --numstat",
        durationMs: 10,
        exitCode: 0,
        output: "4\t1\tapi-contract.yaml\n",
      });
    evaluateReviewTriggersMock.mockReturnValueOnce(
      emptyEvaluation({
        humanReviewRequired: true,
        changedFiles: ["api-contract.yaml"],
        diffStats: { fileCount: 1, addedLines: 4, deletedLines: 1 },
        triggers: [{
          action: "require_human_review",
          name: "api_contract_change",
          severity: "high",
          confidenceThreshold: null,
          fallbackAction: null,
          specialistId: null,
          provider: null,
          model: null,
          context: [],
          reviewLayers: [],
          reasons: ["sensitive file changed: api-contract.yaml"],
        }],
      }),
    );

    const result = await runReviewTriggerPhase("jsonl");

    expect(result.allowed).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.message).toContain("Human review required before push");
    expect(runReviewTriggerSpecialistMock).not.toHaveBeenCalled();
  });

  it("blocks immediately when a trigger uses block action", async () => {
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 0,
        output: `${process.cwd()}\n`,
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR origin/main",
        durationMs: 5,
        exitCode: 0,
        output: "src/core/acp/process.ts\n",
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git ls-files --others --exclude-standard",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git diff --numstat",
        durationMs: 10,
        exitCode: 0,
        output: "12\t3\tsrc/core/acp/process.ts\n",
      });
    evaluateReviewTriggersMock.mockReturnValueOnce(
      emptyEvaluation({
        blocked: true,
        changedFiles: ["src/core/acp/process.ts"],
        diffStats: { fileCount: 1, addedLines: 12, deletedLines: 3 },
        triggers: [{
          action: "block",
          name: "forbidden_change",
          severity: "high",
          confidenceThreshold: null,
          fallbackAction: null,
          specialistId: null,
          provider: null,
          model: null,
          context: [],
          reviewLayers: [],
          reasons: ["changed path: src/core/acp/process.ts"],
        }],
      }),
    );

    const result = await runReviewTriggerPhase("jsonl");

    expect(result.allowed).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.message).toContain("Review trigger blocked the push");
    expect(runReviewTriggerSpecialistMock).not.toHaveBeenCalled();
  });

  it("escalates staged review to human review when confidence is below threshold", async () => {
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 0,
        output: `${process.cwd()}\n`,
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR origin/main",
        durationMs: 5,
        exitCode: 0,
        output: "src/core/acp/process.ts\n",
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git ls-files --others --exclude-standard",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git diff --numstat",
        durationMs: 10,
        exitCode: 0,
        output: "20\t6\tsrc/core/acp/process.ts\n",
      });
    evaluateReviewTriggersMock.mockReturnValueOnce(
      emptyEvaluation({
        stagedReviewRequired: true,
        changedFiles: ["src/core/acp/process.ts"],
        diffStats: { fileCount: 1, addedLines: 20, deletedLines: 6 },
        triggers: [{
          action: "staged",
          confidenceThreshold: 9,
          fallbackAction: "require_human_review",
          name: "high_risk_directory_change",
          severity: "high",
          specialistId: null,
          provider: null,
          model: null,
          context: [],
          reviewLayers: [],
          reasons: ["changed path: src/core/acp/process.ts"],
        }],
      }),
    );
    runReviewTriggerSpecialistMock.mockResolvedValueOnce({
      allowed: true,
      outcome: "pass",
      summary: "Automatic review specialist approved the push.",
      confidence: 7,
      findings: [],
      raw: "{\"decision\":\"pass\",\"confidence\":7}",
    });

    const result = await runReviewTriggerPhase("jsonl");

    expect(result.allowed).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.message).toContain("below the required 9/10");
    expect(result.message).toContain("Human review fallback required");
  });

  it("passes staged review after escalating to a later review layer", async () => {
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 0,
        output: `${process.cwd()}\n`,
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR origin/main",
        durationMs: 5,
        exitCode: 0,
        output: "src/core/acp/process.ts\n",
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git ls-files --others --exclude-standard",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git diff --numstat",
        durationMs: 10,
        exitCode: 0,
        output: "20\t6\tsrc/core/acp/process.ts\n",
      });
    evaluateReviewTriggersMock.mockReturnValueOnce(
      emptyEvaluation({
        stagedReviewRequired: true,
        changedFiles: ["src/core/acp/process.ts"],
        diffStats: { fileCount: 1, addedLines: 20, deletedLines: 6 },
        triggers: [{
          action: "staged",
          confidenceThreshold: 8,
          fallbackAction: "require_human_review",
          provider: "codex",
          model: "gpt-5.4-mini",
          context: ["graph_review_context"],
          reviewLayers: [
            {
              provider: "codex",
              model: "gpt-5.4-mini",
              confidenceThreshold: 7,
              specialistId: null,
              context: [],
            },
            {
              provider: "claude",
              model: "claude-sonnet",
              confidenceThreshold: 9,
              specialistId: null,
              context: [],
            },
          ],
          name: "high_risk_directory_change",
          severity: "high",
          specialistId: null,
          reasons: ["changed path: src/core/acp/process.ts"],
        }],
      }),
    );
    runReviewTriggerSpecialistMock
      .mockResolvedValueOnce({
        allowed: true,
        outcome: "escalate",
        summary: "Fast review wants a deeper pass.",
        confidence: 7,
        findings: [],
        raw: "{\"decision\":\"escalate\",\"confidence\":7}",
      })
      .mockResolvedValueOnce({
        allowed: true,
        outcome: "pass",
        summary: "Deep review approved the push.",
        confidence: 9,
        findings: [],
        raw: "{\"decision\":\"pass\",\"confidence\":9}",
      });

    const result = await runReviewTriggerPhase("jsonl");

    expect(result.allowed).toBe(true);
    expect(result.status).toBe("passed");
    expect(runReviewTriggerSpecialistMock).toHaveBeenCalledTimes(2);
    expect(result.message).toContain("Review layer 1/2");
    expect(result.message).toContain("Moving to the next review layer");
    expect(result.message).toContain("Review layer 2/2: Deep review approved the push.");
  });

  it("prints a compact human summary table for matched triggers", async () => {
    delete process.env.ROUTA_ALLOW_REVIEW_TRIGGER_PUSH;
    const numstatLines = ["942\t636\tsrc/a.ts"];
    for (let index = 1; index < 32; index += 1) {
      numstatLines.push(`0\t0\tsrc/generated/file-${index}.ts`);
    }
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 0,
        output: `${process.cwd()}\n`,
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR origin/main",
        durationMs: 5,
        exitCode: 0,
        output: "src/a.ts\nsrc/b.ts\napi-contract.yaml\n",
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR",
        durationMs: 5,
        exitCode: 0,
        output: "src/local-only.ts\n",
      })
      .mockResolvedValueOnce({
        command: "git ls-files --others --exclude-standard",
        durationMs: 5,
        exitCode: 0,
        output: "tmp/debug.txt\n",
      })
      .mockResolvedValueOnce({
        command: "git diff --numstat",
        durationMs: 10,
        exitCode: 0,
        output: `${numstatLines.join("\n")}\n`,
      });
    evaluateReviewTriggersMock.mockReturnValueOnce(
      emptyEvaluation({
        stagedReviewRequired: true,
        changedFiles: ["src/a.ts", "src/b.ts", "api-contract.yaml"],
        diffStats: { fileCount: 32, addedLines: 942, deletedLines: 636 },
        triggers: [
          {
            action: "staged",
            name: "high_risk_directory_change",
            severity: "high",
            confidenceThreshold: null,
            fallbackAction: "require_human_review",
            specialistId: null,
            provider: null,
            model: null,
            context: [],
            reviewLayers: [],
            reasons: [
              "changed path: src/core/acp/process.ts",
              "changed path: src/core/acp/recovery.ts",
              "changed path: src/core/acp/session-lease.ts",
            ],
          },
          {
            action: "staged",
            name: "oversized_change",
            severity: "medium",
            confidenceThreshold: null,
            fallbackAction: "require_human_review",
            specialistId: null,
            provider: null,
            model: null,
            context: [],
            reviewLayers: [],
            reasons: [
              "diff touched 32 files (threshold: 12)",
              "diff added 942 lines (threshold: 600)",
              "diff deleted 636 lines (threshold: 400)",
            ],
          },
        ],
      }),
    );
    runReviewTriggerSpecialistMock.mockResolvedValueOnce({
      allowed: false,
      outcome: "block",
      summary: "Automatic review specialist found a regression risk.",
      confidence: 9,
      findings: [{ severity: "high", title: "Regression risk", reason: "Control flow changed without safeguards." }],
      raw: "{\"decision\":\"block\",\"confidence\":9}",
    });
    buildOwnershipRoutingContextMock.mockReturnValueOnce({
      changedFiles: ["src/a.ts", "src/b.ts", "api-contract.yaml"],
      touchedOwners: ["@arch-team", "@platform-team"],
      touchedOwnerGroupsCount: 2,
      unownedChangedFiles: ["api-contract.yaml"],
      overlappingChangedFiles: ["src/a.ts"],
      highRiskUnownedFiles: ["api-contract.yaml"],
      crossOwnerTriggers: ["cross_boundary_change_core_api"],
      triggerCorrelations: [],
    });

    const result = await runReviewTriggerPhase("human");

    expect(result.allowed).toBe(false);
    const output = consoleLogSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(output).toContain("Automatic review required: 2 triggers across 3 committed files.");
    expect(output).toMatch(/\|\s+Base\s+\|\s+origin\/main\s+\|/);
    expect(output).toMatch(/\|\s+Added lines\s+\|\s+942 \(limit 600\)\s+\|/);
    expect(output).toMatch(/\|\s+Workspace residue\s+\|\s+1 tracked, 1 untracked\s+\|/);
    expect(output).toContain("@arch-team, @platform-team");
    expect(output).toContain("api-contract.yaml");
    expect(output).toContain("cross_boundary_change_core_api");
    expect(output).toContain("Matched triggers:");
    expect(output).toContain("[HIGH] High Risk Directory Change");
    expect(output).toContain("changed path:");
    expect(output).toContain("src/core/acp/process.ts");
    expect(output).toContain("src/core/acp/recovery.ts");
    expect(output).toContain("src/core/acp/session-lease.ts");
    expect(output).not.toContain("- Base: origin/main");
  });

  it("deprioritizes lower-signal files in medium-severity examples", async () => {
    delete process.env.ROUTA_ALLOW_REVIEW_TRIGGER_PUSH;
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 0,
        output: `${process.cwd()}\n`,
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR origin/main",
        durationMs: 5,
        exitCode: 0,
        output: "src/app/globals.css\nsrc/app/page.tsx\ndocs/fitness/README.md\nsrc/core/review.ts\n",
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git ls-files --others --exclude-standard",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git diff --numstat",
        durationMs: 10,
        exitCode: 0,
        output: "42\t7\tsrc/app/page.tsx\n",
      });
    evaluateReviewTriggersMock.mockReturnValueOnce(
      emptyEvaluation({
        stagedReviewRequired: true,
        changedFiles: [
          "src/app/globals.css",
          "src/app/page.tsx",
          "docs/fitness/README.md",
          "src/core/review.ts",
        ],
        diffStats: { fileCount: 4, addedLines: 42, deletedLines: 7 },
        triggers: [
          {
            action: "staged",
            name: "fitness_evidence_gap_for_core_paths",
            severity: "medium",
            confidenceThreshold: null,
            fallbackAction: "require_human_review",
            specialistId: null,
            provider: null,
            model: null,
            context: [],
            reviewLayers: [],
            reasons: [
              "changed code path without evidence update: src/app/globals.css, src/app/page.tsx, docs/fitness/README.md, src/core/review.ts, src/app/layout.tsx",
            ],
          },
        ],
      }),
    );
    runReviewTriggerSpecialistMock.mockResolvedValueOnce({
      allowed: false,
      outcome: "block",
      summary: "Automatic review specialist found a regression risk.",
      confidence: 9,
      findings: [],
      raw: "{\"decision\":\"block\",\"confidence\":9}",
    });

    const result = await runReviewTriggerPhase("human");

    expect(result.allowed).toBe(false);
    const output = consoleLogSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(output).toContain("[MEDIUM] Fitness Evidence Gap For Core Paths");
    expect(output).toContain("Examples: src/app/page.tsx, src/core/review.ts, src/app/layout.tsx, src/app/globals.css");
    expect(output).toContain("+1 more lower-signal file");
  });

  it("allows matched review trigger when bypass env var is set", async () => {
    process.env.ROUTA_ALLOW_REVIEW_TRIGGER_PUSH = "1";
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 0,
        output: `${process.cwd()}\n`,
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR origin/main",
        durationMs: 5,
        exitCode: 0,
        output: "tools/hook-runtime/src/review.ts\n",
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git ls-files --others --exclude-standard",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git diff --numstat",
        durationMs: 10,
        exitCode: 0,
        output: "10\t2\ttools/hook-runtime/src/review.ts\n",
      });
    evaluateReviewTriggersMock.mockReturnValueOnce(
      emptyEvaluation({
        stagedReviewRequired: true,
        changedFiles: ["tools/hook-runtime/src/review.ts"],
        diffStats: { fileCount: 1, addedLines: 10, deletedLines: 2 },
        triggers: [{
          action: "staged",
          name: "oversized_change",
          severity: "high",
          confidenceThreshold: null,
          fallbackAction: "require_human_review",
          specialistId: null,
          provider: null,
          model: null,
          context: [],
          reviewLayers: [],
          reasons: ["diff added 10 lines (threshold: 600)"],
        }],
      }),
    );

    const result = await runReviewTriggerPhase("jsonl");

    expect(result.allowed).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.bypassed).toBe(true);
    expect(result.triggers).toHaveLength(1);
    expect(result.message).toContain("ROUTA_ALLOW_REVIEW_TRIGGER_PUSH=1 set");
    expect(runReviewTriggerSpecialistMock).not.toHaveBeenCalled();
  });

  it("reports committed files from the push scope", async () => {
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 0,
        output: `${process.cwd()}\n`,
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR origin/main",
        durationMs: 5,
        exitCode: 0,
        output: "tools/hook-runtime/src/review.ts\n",
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git ls-files --others --exclude-standard",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git diff --numstat",
        durationMs: 10,
        exitCode: 0,
        output: "10\t2\ttools/hook-runtime/src/review.ts\n",
      });
    evaluateReviewTriggersMock.mockReturnValueOnce(
      emptyEvaluation({
        stagedReviewRequired: true,
        changedFiles: ["tools/hook-runtime/src/review.ts"],
        diffStats: { fileCount: 1, addedLines: 10, deletedLines: 2 },
        triggers: [{
          action: "staged",
          name: "oversized_change",
          severity: "high",
          confidenceThreshold: null,
          fallbackAction: "require_human_review",
          specialistId: null,
          provider: null,
          model: null,
          context: [],
          reviewLayers: [],
          reasons: ["diff added 10 lines (threshold: 600)"],
        }],
      }),
    );
    runReviewTriggerSpecialistMock.mockResolvedValueOnce({
      allowed: true,
      outcome: "pass",
      summary: "Automatic review specialist approved the push.",
      confidence: 9,
      findings: [],
      raw: "{\"decision\":\"pass\",\"confidence\":9}",
    });

    const result = await runReviewTriggerPhase("jsonl");

    expect(result.changedFiles).toEqual(["tools/hook-runtime/src/review.ts"]);
    expect(result.committedFiles).toEqual(["tools/hook-runtime/src/review.ts"]);
    expect(result.allowed).toBe(true);
  });

  it("passes without evaluating triggers when push scope has no committed files", async () => {
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 0,
        output: `${process.cwd()}\n`,
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR origin/main",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR",
        durationMs: 5,
        exitCode: 0,
        output: "tools/hook-runtime/src/runtime.ts\n",
      })
      .mockResolvedValueOnce({
        command: "git ls-files --others --exclude-standard",
        durationMs: 5,
        exitCode: 0,
        output: "tmp/debug.txt\n",
      });

    const result = await runReviewTriggerPhase("jsonl");

    expect(result.allowed).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.committedFiles).toEqual([]);
    expect(result.workingTreeFiles).toEqual(["tools/hook-runtime/src/runtime.ts"]);
    expect(result.untrackedFiles).toEqual(["tmp/debug.txt"]);
    expect(runCommandMock).toHaveBeenCalledTimes(5);
    expect(evaluateReviewTriggersMock).not.toHaveBeenCalled();
  });

  it("blocks push when review evaluation is unavailable by default", async () => {
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 0,
        output: `${process.cwd()}\n`,
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR origin/main",
        durationMs: 5,
        exitCode: 0,
        output: "tools/hook-runtime/src/review.ts\n",
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git ls-files --others --exclude-standard",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git diff --numstat",
        durationMs: 10,
        exitCode: 0,
        output: "10\t2\ttools/hook-runtime/src/review.ts\n",
      });
    evaluateReviewTriggersMock.mockImplementationOnce(() => {
      throw new Error("review trigger rules failed to load");
    });

    const result = await runReviewTriggerPhase("jsonl");

    expect(result.allowed).toBe(false);
    expect(result.bypassed).toBe(false);
    expect(result.status).toBe("unavailable");
    expect(result.message).toContain("Blocking push");
    expect(result.message).toContain("ROUTA_ALLOW_REVIEW_UNAVAILABLE=1");
  });

  it("prints a short unavailable message in human mode when specialist review fails", async () => {
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 0,
        output: `${process.cwd()}\n`,
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR origin/main",
        durationMs: 5,
        exitCode: 0,
        output: "tools/hook-runtime/src/review.ts\n",
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git ls-files --others --exclude-standard",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git diff --numstat",
        durationMs: 10,
        exitCode: 0,
        output: "10\t2\ttools/hook-runtime/src/review.ts\n",
      });
    evaluateReviewTriggersMock.mockReturnValueOnce(
      emptyEvaluation({
        stagedReviewRequired: true,
        changedFiles: ["tools/hook-runtime/src/review.ts"],
        diffStats: { fileCount: 1, addedLines: 10, deletedLines: 2 },
        triggers: [{
          action: "staged",
          name: "oversized_change",
          severity: "high",
          confidenceThreshold: null,
          fallbackAction: "require_human_review",
          specialistId: null,
          provider: null,
          model: null,
          context: [],
          reviewLayers: [],
          reasons: ["diff added 10 lines (threshold: 600)"],
        }],
      }),
    );
    runReviewTriggerSpecialistMock.mockRejectedValueOnce(
      new Error("Missing ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY for automatic review specialist."),
    );

    const result = await runReviewTriggerPhase("human");

    expect(result.allowed).toBe(false);
    expect(result.status).toBe("unavailable");
    const output = consoleLogSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(output).toContain("Automatic review specialist unavailable.");
    expect(output).toContain("Missing ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY");
    expect(output).toContain("ROUTA_ALLOW_REVIEW_UNAVAILABLE=1");
  });

  it("allows explicit bypass when review evaluation is unavailable", async () => {
    process.env.ROUTA_ALLOW_REVIEW_UNAVAILABLE = "1";
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 0,
        output: `${process.cwd()}\n`,
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR origin/main",
        durationMs: 5,
        exitCode: 0,
        output: "tools/hook-runtime/src/review.ts\n",
      })
      .mockResolvedValueOnce({
        command: "git diff --name-only --diff-filter=ACMR",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git ls-files --others --exclude-standard",
        durationMs: 5,
        exitCode: 0,
        output: "",
      })
      .mockResolvedValueOnce({
        command: "git diff --numstat",
        durationMs: 10,
        exitCode: 0,
        output: "10\t2\ttools/hook-runtime/src/review.ts\n",
      });
    evaluateReviewTriggersMock.mockImplementationOnce(() => {
      throw new Error("review trigger rules failed to load");
    });

    const result = await runReviewTriggerPhase("jsonl");

    expect(result.allowed).toBe(true);
    expect(result.bypassed).toBe(true);
    expect(result.status).toBe("unavailable");
    expect(result.message).toContain("ROUTA_ALLOW_REVIEW_UNAVAILABLE=1");
  });

  it("marks review unavailable when executed from a non-repository root", async () => {
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 0,
        output: "/tmp/other-repo\n",
      });

    const result = await runReviewTriggerPhase("jsonl");

    expect(result.allowed).toBe(false);
    expect(result.status).toBe("unavailable");
    expect(runCommandMock).toHaveBeenCalledTimes(2);
    expect(result.message).toContain("Review scope mismatch");
  });

  it("marks review unavailable when git root cannot be resolved", async () => {
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 1,
        output: "",
      });

    const result = await runReviewTriggerPhase("jsonl");

    expect(result.allowed).toBe(false);
    expect(result.status).toBe("unavailable");
    expect(result.message).toContain("No git repository root found");
    expect(runCommandMock).toHaveBeenCalledTimes(2);
  });

  it("allows explicit bypass when git root cannot be resolved", async () => {
    process.env.ROUTA_ALLOW_REVIEW_UNAVAILABLE = "1";
    runCommandMock
      .mockResolvedValueOnce({
        command: "git rev-parse",
        durationMs: 5,
        exitCode: 0,
        output: "origin/main\n",
      })
      .mockResolvedValueOnce({
        command: "git rev-parse --show-toplevel",
        durationMs: 5,
        exitCode: 1,
        output: "",
      });

    const result = await runReviewTriggerPhase("jsonl");

    expect(result.allowed).toBe(true);
    expect(result.status).toBe("unavailable");
    expect(result.bypassed).toBe(true);
    expect(result.message).toContain("No git repository root found");
  });
});
