/**
 * Characterization tests for POST /api/fitness/analyze.
 *
 * These tests lock the observable contract of the route:
 * - Response envelope shape (generatedAt, requestedProfiles, profiles[])
 * - Per-profile status mapping (ok / missing / error)
 * - Parameter validation (profile, mode, compareLast, noSave)
 * - Console transcript fields
 * - Error mapping (context errors → 400, other errors → 500)
 * - DEFAULT_COMPARE_LAST = true
 *
 * The engine module is mocked to avoid running real detectors.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the engine module
const mockRunFluencyAnalysis = vi.fn();
vi.mock("@/core/fitness/fluency", () => ({
  runFluencyAnalysis: (...args: unknown[]) => mockRunFluencyAnalysis(...args),
}));

// Mock the repo-root module to avoid needing a real workspace
vi.mock("@/core/fitness/repo-root", () => ({
  resolveFitnessRepoRoot: vi.fn().mockResolvedValue("/mock/repo/root"),
  normalizeFitnessContextValue: (value: unknown) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  },
  isFitnessContextError: (message: string) =>
    message.includes("缺少 fitness 上下文")
    || message.includes("Codebase 未找到")
    || message.includes("Codebase 的路径")
    || message.includes("repoPath")
    || message.includes("Workspace 下没有配置 codebase")
    || message.includes("不存在或不是目录"),
}));

// Mock getRoutaSystem to avoid real store access
vi.mock("@/core/routa-system", () => ({
  getRoutaSystem: () => ({
    codebaseStore: {
      get: vi.fn(),
      listByWorkspace: vi.fn(),
    },
  }),
}));

import { POST } from "../route";
import { NextRequest } from "next/server";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/fitness/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeFabricatedReport(overrides: Record<string, unknown> = {}) {
  return {
    modelVersion: 2,
    modelPath: "/mock/repo/root/docs/fitness/harness-fluency.model.yaml",
    profile: "generic",
    mode: "deterministic",
    framing: "fluency",
    repoRoot: "/mock/repo/root",
    generatedAt: "2026-01-01T00:00:00.000Z",
    snapshotPath: "/mock/repo/root/docs/fitness/reports/harness-fluency-latest.json",
    overallLevel: "awareness",
    overallLevelName: "Awareness",
    currentLevelReadiness: 0.75,
    nextLevel: "assisted_coding",
    nextLevelName: "Assisted Coding",
    nextLevelReadiness: 0.3,
    blockingTargetLevel: "assisted_coding",
    blockingTargetLevelName: "Assisted Coding",
    dimensions: {
      collaboration: {
        dimension: "collaboration",
        name: "Task Delegation",
        level: "awareness",
        levelName: "Awareness",
        levelIndex: 0,
        score: 0.8,
        nextLevel: "assisted_coding",
        nextLevelName: "Assisted Coding",
        nextLevelProgress: 0.3,
      },
    },
    capabilityGroups: {},
    evidencePacks: [],
    cells: [],
    criteria: [],
    blockingCriteria: [],
    recommendations: [],
    baseline: {
      summary: {
        score: 0.15,
        overallLevel: "awareness",
        overallLevelName: "Awareness",
        currentReadiness: 0.75,
        nextLevel: "assisted_coding",
        nextLevelName: "Assisted Coding",
      },
      dominantGaps: [],
      topActions: [],
      autonomyRecommendation: { band: "low", rationale: "test" },
    },
    comparison: null,
    ...overrides,
  };
}

describe("POST /api/fitness/analyze", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the response envelope with generatedAt, requestedProfiles, and profiles", async () => {
    mockRunFluencyAnalysis.mockReturnValue(makeFabricatedReport());

    const response = await POST(makeRequest({ profile: "generic" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.generatedAt).toBeDefined();
    expect(typeof body.generatedAt).toBe("string");
    expect(body.requestedProfiles).toEqual(["generic"]);
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].profile).toBe("generic");
    expect(body.profiles[0].status).toBe("ok");
    expect(body.profiles[0].source).toBe("analysis");
    expect(body.profiles[0].report).toBeDefined();
    expect(body.profiles[0].report.overallLevel).toBe("awareness");
  });

  it("defaults to generic profile when no profile is specified", async () => {
    mockRunFluencyAnalysis.mockReturnValue(makeFabricatedReport());

    const response = await POST(makeRequest({}));
    const body = await response.json();

    expect(body.requestedProfiles).toEqual(["generic"]);
    expect(body.profiles[0].profile).toBe("generic");
  });

  it("supports runBoth to request all profiles", async () => {
    mockRunFluencyAnalysis
      .mockReturnValueOnce(makeFabricatedReport({ profile: "generic" }))
      .mockReturnValueOnce(makeFabricatedReport({ profile: "agent_orchestrator" }));

    const response = await POST(makeRequest({ runBoth: true }));
    const body = await response.json();

    expect(body.requestedProfiles).toEqual(["generic", "agent_orchestrator"]);
    expect(body.profiles).toHaveLength(2);
    expect(body.profiles[0].profile).toBe("generic");
    expect(body.profiles[1].profile).toBe("agent_orchestrator");
  });

  it("passes compareLast=true by default (DEFAULT_COMPARE_LAST)", async () => {
    mockRunFluencyAnalysis.mockReturnValue(makeFabricatedReport());

    await POST(makeRequest({ profile: "generic" }));

    expect(mockRunFluencyAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        compareLast: true,
      }),
    );
  });

  it("passes noSave=false by default", async () => {
    mockRunFluencyAnalysis.mockReturnValue(makeFabricatedReport());

    await POST(makeRequest({ profile: "generic" }));

    expect(mockRunFluencyAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        noSave: false,
      }),
    );
  });

  it("respects explicit compareLast=false", async () => {
    mockRunFluencyAnalysis.mockReturnValue(makeFabricatedReport());

    await POST(makeRequest({ profile: "generic", compareLast: false }));

    expect(mockRunFluencyAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        compareLast: false,
      }),
    );
  });

  it("respects explicit noSave=true", async () => {
    mockRunFluencyAnalysis.mockReturnValue(makeFabricatedReport());

    await POST(makeRequest({ profile: "generic", noSave: true }));

    expect(mockRunFluencyAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        noSave: true,
      }),
    );
  });

  it("defaults mode to deterministic", async () => {
    mockRunFluencyAnalysis.mockReturnValue(makeFabricatedReport());

    await POST(makeRequest({ profile: "generic" }));

    expect(mockRunFluencyAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "deterministic",
      }),
    );
  });

  it("passes explicit mode through", async () => {
    mockRunFluencyAnalysis.mockReturnValue(makeFabricatedReport());

    await POST(makeRequest({ profile: "generic", mode: "hybrid" }));

    expect(mockRunFluencyAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "hybrid",
      }),
    );
  });

  it("ignores invalid mode and falls back to deterministic", async () => {
    mockRunFluencyAnalysis.mockReturnValue(makeFabricatedReport());

    await POST(makeRequest({ profile: "generic", mode: "invalid_mode" }));

    expect(mockRunFluencyAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "deterministic",
      }),
    );
  });

  it("includes console transcript with command, args, and data", async () => {
    mockRunFluencyAnalysis.mockReturnValue(makeFabricatedReport());

    const response = await POST(makeRequest({ profile: "generic" }));
    const body = await response.json();

    const profile = body.profiles[0];
    expect(profile.console).toBeDefined();
    expect(profile.console.command).toBeDefined();
    expect(profile.console.args).toBeDefined();
    expect(Array.isArray(profile.console.args)).toBe(true);
    expect(profile.console.data).toBeDefined();
    expect(typeof profile.console.data).toBe("string");
  });

  it("includes durationMs for successful runs", async () => {
    mockRunFluencyAnalysis.mockReturnValue(makeFabricatedReport());

    const response = await POST(makeRequest({ profile: "generic" }));
    const body = await response.json();

    expect(body.profiles[0].durationMs).toBeDefined();
    expect(typeof body.profiles[0].durationMs).toBe("number");
  });

  it("maps engine errors to status error with error field", async () => {
    mockRunFluencyAnalysis.mockImplementation(() => {
      throw new Error("Model loading failed");
    });

    const response = await POST(makeRequest({ profile: "generic" }));
    const body = await response.json();

    expect(response.status).toBe(200); // Per-profile errors don't fail the request
    expect(body.profiles[0].status).toBe("error");
    expect(body.profiles[0].error).toContain("Model loading failed");
    expect(body.profiles[0].console).toBeDefined();
  });

  it("returns 400 for fitness context errors", async () => {
    // Override the mock to throw a context error
    const { resolveFitnessRepoRoot } = await import("@/core/fitness/repo-root");
    vi.mocked(resolveFitnessRepoRoot).mockRejectedValueOnce(
      new Error("缺少 fitness 上下文，请提供 workspaceId / codebaseId / repoPath 之一"),
    );

    const response = await POST(makeRequest({ profile: "generic" }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBeDefined();
    expect(body.details).toContain("fitness 上下文");
  });

  it("returns 500 for non-context errors during setup", async () => {
    const { resolveFitnessRepoRoot } = await import("@/core/fitness/repo-root");
    vi.mocked(resolveFitnessRepoRoot).mockRejectedValueOnce(
      new Error("Unexpected server error"),
    );

    const response = await POST(makeRequest({ profile: "generic" }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBeDefined();
  });

  it("deduplicates profiles in the request", async () => {
    mockRunFluencyAnalysis.mockReturnValue(makeFabricatedReport());

    const response = await POST(makeRequest({
      profiles: ["generic", "generic"],
    }));
    const body = await response.json();

    expect(body.requestedProfiles).toEqual(["generic"]);
    expect(body.profiles).toHaveLength(1);
  });

  it("filters out invalid profiles", async () => {
    mockRunFluencyAnalysis.mockReturnValue(makeFabricatedReport());

    const response = await POST(makeRequest({
      profiles: ["generic", "invalid_profile"],
    }));
    const body = await response.json();

    expect(body.requestedProfiles).toEqual(["generic"]);
    expect(body.profiles).toHaveLength(1);
  });

  it("falls back to generic when all profiles are invalid", async () => {
    mockRunFluencyAnalysis.mockReturnValue(makeFabricatedReport());

    const response = await POST(makeRequest({
      profiles: ["invalid1", "invalid2"],
    }));
    const body = await response.json();

    expect(body.requestedProfiles).toEqual(["generic"]);
    expect(body.profiles).toHaveLength(1);
  });

  it("handles body parse failure gracefully (falls back to {})", async () => {
    mockRunFluencyAnalysis.mockReturnValue(makeFabricatedReport());

    const request = new NextRequest("http://localhost/api/fitness/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.requestedProfiles).toEqual(["generic"]);
  });

  it("preserves report field names in camelCase", async () => {
    const report = makeFabricatedReport();
    mockRunFluencyAnalysis.mockReturnValue(report);

    const response = await POST(makeRequest({ profile: "generic" }));
    const body = await response.json();

    const returnedReport = body.profiles[0].report;
    expect(returnedReport.modelVersion).toBeDefined();
    expect(returnedReport.overallLevel).toBeDefined();
    expect(returnedReport.overallLevelName).toBeDefined();
    expect(returnedReport.currentLevelReadiness).toBeDefined();
    expect(returnedReport.dimensions).toBeDefined();
    expect(returnedReport.cells).toBeDefined();
    expect(returnedReport.criteria).toBeDefined();
    expect(returnedReport.blockingCriteria).toBeDefined();
    expect(returnedReport.recommendations).toBeDefined();
  });
});
