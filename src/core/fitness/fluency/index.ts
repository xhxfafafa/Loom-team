/**
 * Public API for the harness fluency fitness engine.
 *
 * This module is the TypeScript port of the Rust harness fluency engine
 * (crates/routa-cli/src/commands/fitness/fluency/).
 *
 * ## Known limitations vs the Rust engine:
 *
 * 1. **hybrid/ai modes**: The Rust engine shells out to the `claude` CLI
 *    for AI-enhanced scoring in hybrid and ai modes. This TS port does NOT
 *    invoke any external LLM. Both hybrid and ai modes degrade to
 *    deterministic execution with the same detection and scoring logic.
 *    Evidence packs ARE collected for non-deterministic modes.
 *
 * 2. **codeowners_routing detector**: Always fails in the TS port because
 *    it depends on the routa_core Rust library for CODEOWNERS parsing and
 *    correlation analysis.
 *
 * ## JSON contract:
 *
 * The output types use camelCase field names, matching the Rust engine's
 * `#[serde(rename_all = "camelCase")]` serialization. The snapshot files
 * are written to the same paths as the Rust engine:
 *   - generic: docs/fitness/reports/harness-fluency-latest.json
 *   - agent_orchestrator: docs/fitness/reports/harness-fluency-agent-orchestrator-latest.json
 */

import * as path from "path";

import { evaluateHarnessFluency } from "./engine";

export { evaluateHarnessFluency } from "./engine";
export { formatTextReport } from "./report";
export { loadFluencyModel } from "./model";
export {
  buildComparison,
  canCompareReports,
  loadPreviousSnapshot,
  persistSnapshot,
} from "./snapshot";
export { buildEvidencePacks } from "./evidence-pack";
export { buildHarnessabilityBaseline } from "./baseline";

// Re-export types
export type {
  AutonomyBand,
  AutonomyRecommendation,
  BaselineSummary,
  CapabilityGroupResult,
  CellResult,
  CriterionChange,
  CriterionResult,
  CriterionStatus,
  DetectorDefinition,
  DimensionChange,
  DimensionResult,
  DominantGap,
  EvidenceExcerpt,
  EvidenceMode,
  EvidencePack,
  EvaluateOptions,
  FluencyCapabilityGroup,
  FluencyCriterion,
  FluencyDimension,
  FluencyLevel,
  FluencyMode,
  FluencyModel,
  HarnessFluencyReport,
  HarnessabilityBaseline,
  LevelChange,
  PathSegment,
  Recommendation,
  ReportComparison,
  ReportFraming,
} from "./types";

// Re-export constants
export {
  CELL_PASS_THRESHOLD,
  MAX_RECOMMENDATIONS,
  MAX_REGEX_INPUT_LENGTH,
  MAX_REGEX_PATTERN_LENGTH,
} from "./types";

/**
 * Run a fluency analysis with the standard profile-based configuration.
 * This is the primary entry point for the route handler and CLI.
 *
 * @param options.repoRoot - Absolute path to the repository root
 * @param options.profile - "generic" or "agent_orchestrator"
 * @param options.mode - "deterministic" (default), "hybrid", or "ai"
 * @param options.compareLast - Whether to compare with the previous snapshot (default true)
 * @param options.noSave - Whether to skip saving the snapshot (default false)
 * @param options.framing - "fluency" (default) or "harnessability"
 */
export function runFluencyAnalysis(options: {
  repoRoot: string;
  profile: string;
  mode?: "deterministic" | "hybrid" | "ai";
  compareLast?: boolean;
  noSave?: boolean;
  framing?: "fluency" | "harnessability";
}): import("./types").HarnessFluencyReport {
  const profile = options.profile;
  const modelPath = profile === "agent_orchestrator"
    ? path.join(options.repoRoot, "docs/fitness/harness-fluency.profile.agent_orchestrator.yaml")
    : path.join(options.repoRoot, "docs/fitness/harness-fluency.model.yaml");

  const snapshotPath = profile === "agent_orchestrator"
    ? path.join(options.repoRoot, "docs/fitness/reports/harness-fluency-agent-orchestrator-latest.json")
    : path.join(options.repoRoot, "docs/fitness/reports/harness-fluency-latest.json");

  return evaluateHarnessFluency({
    repoRoot: options.repoRoot,
    modelPath,
    profile,
    mode: options.mode ?? "deterministic",
    framing: options.framing ?? "fluency",
    snapshotPath,
    compareLast: options.compareLast ?? true,
    save: !(options.noSave ?? false),
  });
}
