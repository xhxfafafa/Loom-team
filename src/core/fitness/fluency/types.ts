/**
 * Type definitions for the harness fluency fitness engine.
 *
 * Output types use camelCase to match the Rust engine's JSON serialization
 * (all Rust output structs use #[serde(rename_all = "camelCase")]).
 *
 * Internal model types (FluencyModel, FluencyCriterion, etc.) mirror the
 * Rust internal types and are not serialized directly.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CELL_PASS_THRESHOLD = 0.8;
export const MAX_REGEX_PATTERN_LENGTH = 256;
export const MAX_REGEX_INPUT_LENGTH = 20_000;
export const MAX_RECOMMENDATIONS = 5;

export const ALLOWED_COMMAND_EXECUTABLES = [
  "cargo", "entrix", "git", "node", "npm", "npx", "pnpm", "python", "python3", "uv",
] as const;

export const DEFAULT_GLOB_IGNORE: readonly string[] = [
  "**/.git/**",
  "**/.next/**",
  "**/.next-*/**",
  "**/.next-desktop/**",
  "**/_next/**",
  "**/.nuxt/**",
  "**/.pnpm-store/**",
  "**/.pytest_cache/**",
  "**/.routa/**",
  "**/.ruff_cache/**",
  "**/.turbo/**",
  "**/.venv/**",
  "**/__pycache__/**",
  "**/build/**",
  "**/coverage/**",
  "**/dist/**",
  "**/node_modules/**",
  "**/target/**",
  "**/venv/**",
  "**/vendor/**",
  "**/.worktrees/**",
];

// ---------------------------------------------------------------------------
// Enums / string-literal unions
// ---------------------------------------------------------------------------

export type FluencyMode = "deterministic" | "hybrid" | "ai";
export type ReportFraming = "fluency" | "harnessability";
export type CriterionStatus = "pass" | "fail" | "skipped";
export type LevelChange = "same" | "up" | "down";
export type EvidenceMode = "static" | "runtime" | "hybrid" | "manual" | "ai";
export type AutonomyBand = "low" | "medium" | "high";

// ---------------------------------------------------------------------------
// Detector definition (internal, parsed from YAML)
// ---------------------------------------------------------------------------

export type PathSegment =
  | { kind: "key"; value: string }
  | { kind: "index"; value: number };

export type DetectorDefinition =
  | { type: "file_exists"; path: string }
  | { type: "file_contains_regex"; path: string; pattern: string; flags: string }
  | { type: "all_of"; detectors: DetectorDefinition[] }
  | { type: "any_of"; detectors: DetectorDefinition[] }
  | { type: "any_file_exists"; paths: string[] }
  | {
      type: "codeowners_routing";
      requireCodeowners: boolean;
      maxUnownedFiles?: number;
      maxSensitiveUnownedFiles?: number;
      maxOverlappingFiles?: number;
      requireTriggerAlignment: boolean;
    }
  | { type: "glob_count"; patterns: string[]; min: number }
  | {
      type: "glob_contains_regex";
      patterns: string[];
      pattern: string;
      flags: string;
      minMatches: number;
    }
  | { type: "json_path_exists"; path: string; jsonPath: PathSegment[] }
  | { type: "yaml_path_exists"; path: string; yamlPath: PathSegment[] }
  | { type: "command_exit_code"; command: string; expectedExitCode: number; timeoutMs: number }
  | {
      type: "command_output_regex";
      command: string;
      pattern: string;
      flags: string;
      expectedExitCode: number;
      timeoutMs: number;
    }
  | { type: "manual_attestation"; prompt: string };

// ---------------------------------------------------------------------------
// Internal model types (parsed from YAML, not serialized)
// ---------------------------------------------------------------------------

export type FluencyLevel = {
  id: string;
  name: string;
};

export type FluencyDimension = {
  id: string;
  name: string;
};

export type FluencyCapabilityGroup = {
  id: string;
  name: string;
};

export type FluencyAiCheck = {
  promptTemplate: string;
  requires: string[];
};

export type FluencyCriterion = {
  id: string;
  level: string;
  dimension: string;
  capabilityGroup: string;
  weight: number;
  critical: boolean;
  profiles: string[];
  evidenceMode: EvidenceMode;
  whyItMatters: string;
  recommendedAction: string;
  evidenceHint: string;
  aiCheck: FluencyAiCheck | null;
  detector: DetectorDefinition;
};

export type FluencyModel = {
  version: number;
  levels: FluencyLevel[];
  dimensions: FluencyDimension[];
  capabilityGroups: FluencyCapabilityGroup[];
  criteria: FluencyCriterion[];
};

// ---------------------------------------------------------------------------
// Evaluate options (input to the engine)
// ---------------------------------------------------------------------------

export type EvaluateOptions = {
  repoRoot: string;
  modelPath: string;
  profile: string;
  mode: FluencyMode;
  framing: ReportFraming;
  snapshotPath: string;
  compareLast: boolean;
  save: boolean;
};

// ---------------------------------------------------------------------------
// Serialized output types (camelCase JSON — matches Rust HarnessFluencyReport)
// ---------------------------------------------------------------------------

export type CriterionResult = {
  id: string;
  level: string;
  dimension: string;
  capabilityGroup: string | null;
  capabilityGroupName: string | null;
  weight: number;
  critical: boolean;
  status: CriterionStatus;
  detectorType: string;
  profiles: string[];
  evidenceMode: EvidenceMode;
  detail: string;
  evidence: string[];
  whyItMatters: string;
  recommendedAction: string;
  evidenceHint: string;
};

export type CellResult = {
  id: string;
  level: string;
  levelName: string;
  dimension: string;
  dimensionName: string;
  score: number;
  passed: boolean;
  passedWeight: number;
  applicableWeight: number;
  criteria: CriterionResult[];
};

export type DimensionResult = {
  dimension: string;
  name: string;
  level: string;
  levelName: string;
  levelIndex: number;
  score: number;
  nextLevel: string | null;
  nextLevelName: string | null;
  nextLevelProgress: number | null;
};

export type Recommendation = {
  criterionId: string;
  action: string;
  whyItMatters: string;
  evidenceHint: string;
  critical: boolean;
  weight: number;
};

export type CapabilityGroupResult = {
  capabilityGroup: string;
  name: string;
  score: number;
  criterionCount: number;
  passingCriteria: number;
  failingCriteria: number;
  criticalFailures: number;
  applicableWeight: number;
  passedWeight: number;
  evidenceModes: Record<string, number>;
};

export type EvidenceExcerpt = {
  path: string;
  content: string;
  truncated: boolean;
};

export type EvidencePack = {
  criterionId: string;
  capabilityGroup: string;
  capabilityGroupName: string;
  status: CriterionStatus;
  evidenceMode: EvidenceMode;
  detectorType: string;
  selectionReasons: string[];
  detail: string;
  evidence: string[];
  excerpts: EvidenceExcerpt[];
  whyItMatters: string;
  recommendedAction: string;
  evidenceHint: string;
  aiPromptTemplate: string | null;
  aiRequires: string[];
};

export type DimensionChange = {
  dimension: string;
  previousLevel: string;
  currentLevel: string;
  change: LevelChange;
};

export type CriterionChange = {
  id: string;
  previousStatus: CriterionStatus | null;
  currentStatus: CriterionStatus | null;
};

export type ReportComparison = {
  previousGeneratedAt: string;
  previousOverallLevel: string;
  overallChange: LevelChange;
  dimensionChanges: DimensionChange[];
  criteriaChanges: CriterionChange[];
};

export type BaselineSummary = {
  score: number;
  overallLevel: string;
  overallLevelName: string;
  currentReadiness: number;
  nextLevel: string | null;
  nextLevelName: string | null;
};

export type DominantGap = {
  capabilityGroup: string;
  capabilityGroupName: string;
  score: number;
  failingCriteria: number;
  criticalFailures: number;
  rationale: string;
};

export type AutonomyRecommendation = {
  band: AutonomyBand;
  rationale: string;
};

export type HarnessabilityBaseline = {
  summary: BaselineSummary;
  dominantGaps: DominantGap[];
  topActions: Recommendation[];
  autonomyRecommendation: AutonomyRecommendation;
};

export type HarnessFluencyReport = {
  modelVersion: number;
  modelPath: string;
  profile: string;
  mode: FluencyMode;
  framing: ReportFraming;
  repoRoot: string;
  generatedAt: string;
  snapshotPath: string;
  overallLevel: string;
  overallLevelName: string;
  currentLevelReadiness: number;
  nextLevel: string | null;
  nextLevelName: string | null;
  nextLevelReadiness: number | null;
  blockingTargetLevel: string | null;
  blockingTargetLevelName: string | null;
  dimensions: Record<string, DimensionResult>;
  capabilityGroups: Record<string, CapabilityGroupResult>;
  evidencePacks: EvidencePack[];
  cells: CellResult[];
  criteria: CriterionResult[];
  blockingCriteria: CriterionResult[];
  recommendations: Recommendation[];
  baseline: HarnessabilityBaseline;
  comparison: ReportComparison | null;
};
