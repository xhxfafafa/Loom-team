import { NextRequest, NextResponse } from "next/server";
import {
  isFitnessContextError,
  normalizeFitnessContextValue,
  resolveFitnessRepoRoot,
  type FitnessContext,
} from "@/core/fitness/repo-root";
import {
  runFluencyAnalysis,
  type HarnessFluencyReport,
} from "@/core/fitness/fluency";

const FITNESS_PROFILES = ["generic", "agent_orchestrator"] as const;
const FITNESS_MODES = ["deterministic", "hybrid", "ai"] as const;
const DEFAULT_COMPARE_LAST = true;
const DEFAULT_MODE = "deterministic";

type FitnessProfile = (typeof FITNESS_PROFILES)[number];
type FitnessMode = (typeof FITNESS_MODES)[number];

type ApiProfileStatus = "ok" | "missing" | "error";
type ApiProfileSource = "analysis";

type FitnessProfileResult = {
  profile: FitnessProfile;
  status: ApiProfileStatus;
  source: ApiProfileSource;
  durationMs?: number;
  report?: FitnessReport;
  console?: FitnessConsole;
  error?: string;
};

type FitnessAnalyzeResponse = {
  generatedAt: string;
  requestedProfiles: FitnessProfile[];
  profiles: FitnessProfileResult[];
};

type FitnessConsole = {
  command: string;
  args: string[];
  data: string;
  stdout: string;
  stderr: string;
  reportText?: string;
  exitCode?: number | null;
  signal?: string | null;
};

type FitnessReport = {
  modelVersion: number;
  modelPath: string;
  profile: FitnessProfile;
  framing?: "fluency" | "harnessability" | (string & {}) | null;
  mode?: string;
  repoRoot: string;
  generatedAt: string;
  snapshotPath: string;
  overallLevel: string;
  overallLevelName: string;
  currentLevelReadiness: number;
  nextLevel?: string | null;
  nextLevelName?: string | null;
  nextLevelReadiness?: number | null;
  blockingTargetLevel?: string | null;
  blockingTargetLevelName?: string | null;
  dimensions: Record<string, FitnessDimensionResult>;
  capabilityGroups?: Record<string, unknown>;
  evidencePacks?: Array<unknown>;
  cells: Array<unknown>;
  criteria: Array<unknown>;
  blockingCriteria: Array<unknown>;
  recommendations: Array<FitnessRecommendation>;
  baseline?: FitnessBaselineReport | null;
  comparison?: FitnessComparison | null;
};

type FitnessDimensionResult = {
  dimension: string;
  name: string;
  level: string;
  levelName: string;
  levelIndex: number;
  score: number;
  nextLevel?: string | null;
  nextLevelName?: string | null;
  nextLevelProgress?: number | null;
};

type FitnessRecommendation = {
  criterionId: string;
  action: string;
  whyItMatters: string;
  evidenceHint: string;
  critical: boolean;
  weight: number;
};

type FitnessBaselineSummary = {
  score: number;
  overallLevel: string;
  overallLevelName: string;
  currentReadiness: number;
  nextLevel?: string | null;
  nextLevelName?: string | null;
};

type FitnessBaselineEntry = {
  id?: string;
  dimension?: string;
  title?: string;
  name?: string;
  label?: string;
  capabilityGroup?: string;
  capabilityGroupName?: string;
  action?: string;
  recommendation?: string;
  summary?: string;
  reason?: string;
  rationale?: string;
  failingCriteria?: number;
  criticalFailures?: number;
  evidenceHint?: string;
  currentLevel?: string;
  currentLevelName?: string;
  targetLevel?: string;
  targetLevelName?: string;
  critical?: boolean;
};

type FitnessBaselineReport = {
  summary: FitnessBaselineSummary;
  dominantGaps?: FitnessBaselineEntry[];
  topActions?: FitnessBaselineEntry[];
  autonomyRecommendation?: {
    band: "low" | "medium" | "high" | (string & {});
    rationale: string;
  };
};

type FitnessDimensionChange = {
  dimension: string;
  previousLevel: string;
  currentLevel: string;
  change: "same" | "up" | "down";
};

type FitnessCriterionChange = {
  id: string;
  previousStatus?: string;
  currentStatus?: string;
};

type FitnessComparison = {
  previousGeneratedAt: string;
  previousOverallLevel: string;
  overallChange: "same" | "up" | "down";
  dimensionChanges: FitnessDimensionChange[];
  criteriaChanges: FitnessCriterionChange[];
};

type AnalyzePayload = {
  compareLast: boolean;
  noSave: boolean;
  mode: FitnessMode;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isValidProfile(value: string | undefined): value is FitnessProfile {
  return value === "generic" || value === "agent_orchestrator";
}

function normalizeProfiles(raw: unknown): FitnessProfile[] {
  if (!raw || typeof raw !== "object") {
    return ["generic"];
  }

  const payload = raw as {
    runBoth?: boolean;
    profile?: string;
    profiles?: unknown;
  };

  const configured: string[] = [];

  if (Array.isArray(payload.profiles)) {
    for (const profile of payload.profiles) {
      if (typeof profile === "string") configured.push(profile);
    }
  }

  if (configured.length === 0 && payload.profile) {
    configured.push(payload.profile);
  }

  const includeBoth = payload.runBoth === true;
  if (includeBoth && configured.length === 0) {
    return [...FITNESS_PROFILES];
  }

  const normalized = configured
    .map((value) => (isValidProfile(value) ? value : undefined))
    .filter((value): value is FitnessProfile => value !== undefined);

  const deduped: FitnessProfile[] = [];
  for (const profile of normalized) {
    if (!deduped.includes(profile)) deduped.push(profile);
  }

  return deduped.length > 0 ? deduped : ["generic"];
}

function parseAnalyzeArgs(body: unknown) {
  const compareLast = body && typeof body === "object" && "compareLast" in body && typeof (body as { compareLast?: unknown }).compareLast === "boolean"
    ? (body as { compareLast?: boolean }).compareLast
    : DEFAULT_COMPARE_LAST;
  const noSave = body && typeof body === "object" && typeof (body as { noSave?: unknown }).noSave === "boolean"
    ? !!(body as { noSave?: boolean }).noSave
    : false;
  const mode = body && typeof body === "object" && typeof (body as { mode?: unknown }).mode === "string"
    && FITNESS_MODES.includes((body as { mode: FitnessMode }).mode)
    ? (body as { mode: FitnessMode }).mode
    : DEFAULT_MODE;

  return {
    compareLast: compareLast ?? DEFAULT_COMPARE_LAST,
    noSave,
    mode,
  };
}

function parseAnalyzeContext(body: unknown): FitnessContext {
  if (!body || typeof body !== "object") {
    return {};
  }

  const payload = body as {
    workspaceId?: unknown;
    codebaseId?: unknown;
    repoPath?: unknown;
  };

  return {
    workspaceId: normalizeFitnessContextValue(payload.workspaceId),
    codebaseId: normalizeFitnessContextValue(payload.codebaseId),
    repoPath: normalizeFitnessContextValue(payload.repoPath),
  };
}

function buildConsoleTranscript(params: {
  profile: string;
  mode: FitnessMode;
  compareLast: boolean;
  noSave: boolean;
  durationMs: number;
  report: HarnessFluencyReport;
}): FitnessConsole {
  const { profile, mode, compareLast, noSave, durationMs, report } = params;

  const command = "node";
  const args = ["src/core/fitness/fluency", "--profile", profile];
  if (mode !== "deterministic") {
    args.push("--mode", mode);
  }
  if (compareLast) args.push("--compare-last");
  if (noSave) args.push("--no-save");

  const summaryLines = [
    "$ " + [command, ...args].join(" "),
    "",
    "stdout:",
    "Harness fluency analysis completed for profile: " + profile,
    "  Overall level: " + report.overallLevelName + " (" + report.overallLevel + ")",
    "  Current readiness: " + Math.round(report.currentLevelReadiness * 100) + "%",
    "  Criteria evaluated: " + report.criteria.length,
    "  Blocking criteria: " + report.blockingCriteria.length,
    "",
    "[exit 0 · " + (durationMs / 1000).toFixed(1) + "s]",
  ];

  return {
    command,
    args,
    data: summaryLines.join("\n") + "\n",
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
  };
}

function buildErrorConsoleTranscript(params: {
  profile: string;
  mode: FitnessMode;
  compareLast: boolean;
  noSave: boolean;
  durationMs: number;
  error: string;
}): FitnessConsole {
  const { profile, mode, compareLast, noSave, durationMs, error } = params;

  const command = "node";
  const args = ["src/core/fitness/fluency", "--profile", profile];
  if (mode !== "deterministic") {
    args.push("--mode", mode);
  }
  if (compareLast) args.push("--compare-last");
  if (noSave) args.push("--no-save");

  const summaryLines = [
    "$ " + [command, ...args].join(" "),
    "",
    "stderr:",
    error,
    "",
    "[exit 1 · " + (durationMs / 1000).toFixed(1) + "s]",
  ];

  return {
    command,
    args,
    data: summaryLines.join("\n") + "\n",
    stdout: "",
    stderr: error,
    exitCode: 1,
    signal: null,
  };
}

function runFitnessProfile(
  repoRoot: string,
  profile: FitnessProfile,
  compareLast: boolean,
  noSave: boolean,
  mode: FitnessMode,
): {
  status: ApiProfileStatus;
  durationMs: number;
  report?: FitnessReport;
  console: FitnessConsole;
  error?: string;
} {
  const startTime = Date.now();

  try {
    const report = runFluencyAnalysis({
      repoRoot,
      profile,
      mode,
      compareLast,
      noSave,
    });

    const durationMs = Date.now() - startTime;
    return {
      status: "ok",
      durationMs,
      report: report as unknown as FitnessReport,
      console: buildConsoleTranscript({
        profile,
        mode,
        compareLast,
        noSave,
        durationMs,
        report,
      }),
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const message = toMessage(error);
    return {
      status: "error",
      durationMs,
      console: buildErrorConsoleTranscript({
        profile,
        mode,
        compareLast,
        noSave,
        durationMs,
        error: message,
      }),
      error: message,
    };
  }
}

function buildResponse(
  profiles: FitnessProfile[],
  payload: AnalyzePayload,
  repoRoot: string,
) {
  const tasks = profiles.map((profile) => {
    const result = runFitnessProfile(
      repoRoot,
      profile,
      payload.compareLast,
      payload.noSave,
      payload.mode,
    );
    const entry: FitnessProfileResult = {
      profile,
      source: "analysis",
      status: result.status,
      durationMs: result.durationMs,
    };

    if (result.status === "ok" && result.report) {
      entry.report = result.report;
      entry.console = result.console;
      return entry;
    }

    entry.console = result.console;
    entry.error = result.error ?? "分析失败（未知错误）";
    return entry;
  });

  return Promise.resolve({
    generatedAt: new Date().toISOString(),
    requestedProfiles: profiles,
    profiles: tasks,
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}) as Record<string, unknown>);
    const profiles = normalizeProfiles(body);
    const options = parseAnalyzeArgs(body);
    const context = parseAnalyzeContext(body);
    const repoRoot = await resolveFitnessRepoRoot(context, {
      preferCurrentRepoForDefaultWorkspace: true,
    });

    const payload = await buildResponse(profiles, options, repoRoot);
    return NextResponse.json(payload as FitnessAnalyzeResponse);
  } catch (error) {
    const message = toMessage(error);
    if (isFitnessContextError(message)) {
      return NextResponse.json(
        {
          error: "Fitness 分析上下文无效",
          details: message,
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        error: "Fitness 分析调用失败",
        details: message,
      },
      { status: 500 },
    );
  }
}
