/**
 * Fitness scoring engine — port of entrix scoring.rs.
 *
 * Semantics (verified against Rust source):
 * - Dimension score = passed/total×100 where passed = Pass+Waived, total = Pass+Fail+Waived.
 *   Skipped and Unknown states are excluded from both numerator and denominator.
 * - final_score = Σ(weight×score)/Σ(weight) over dimensions with weight>0 AND total>0.
 * - hard_gate_blocked = any metric with state Fail AND hard_gate=true.
 * - score_blocked = total_weight>0 AND final_score<min_score (default 80).
 * - runtime_timed_out flag (carried through but not set by scoring).
 *
 * Exit codes (from governance.rs enforce()):
 *   0 — pass
 *   1 — score below minimum threshold (score_blocked)
 *   2 — hard gate failure or runtime timeout
 */

export type MetricState = "pass" | "fail" | "waived" | "skipped" | "unknown";

export type FitnessMetricResult = {
  name: string;
  passed: boolean;
  state: MetricState;
  tier: string;
  hard_gate: boolean;
  duration_ms: number;
  output: string;
};

export type FitnessDimensionScore = {
  name: string;
  weight: number;
  score: number;
  passed: number;
  total: number;
  hard_gate_failures: string[];
  results: FitnessMetricResult[];
};

export type FitnessReport = {
  final_score: number;
  hard_gate_blocked: boolean;
  score_blocked: boolean;
  runtime_timed_out: boolean;
  dimensions: FitnessDimensionScore[];
};

/** States that count as "passed" in scoring (mirrors SCORABLE_PASS_STATES). */
const SCORABLE_PASS_STATES: ReadonlySet<MetricState> = new Set(["pass", "waived"]);

/** States that count toward the total denominator (mirrors SCORABLE_TOTAL_STATES). */
const SCORABLE_TOTAL_STATES: ReadonlySet<MetricState> = new Set(["pass", "fail", "waived"]);

/**
 * Calculate score for a single dimension from its metric results.
 * Port of scoring.rs::score_dimension.
 */
export function scoreDimension(
  results: FitnessMetricResult[],
  dimensionName: string,
  weight: number,
): FitnessDimensionScore {
  if (results.length === 0) {
    return {
      name: dimensionName,
      weight,
      score: 0,
      passed: 0,
      total: 0,
      hard_gate_failures: [],
      results: [],
    };
  }

  const passed = results.filter((r) => SCORABLE_PASS_STATES.has(r.state)).length;
  const total = results.filter((r) => SCORABLE_TOTAL_STATES.has(r.state)).length;
  const score = total > 0 ? (passed / total) * 100 : 0;
  const hard_gate_failures = results
    .filter((r) => r.state === "fail" && r.hard_gate)
    .map((r) => r.name);

  return {
    name: dimensionName,
    weight,
    score,
    passed,
    total,
    hard_gate_failures,
    results,
  };
}

/**
 * Calculate final weighted score across all dimensions.
 * Port of scoring.rs::score_report.
 *
 * Formula: Σ(Weight_i × Score_i) / Σ(Weight_i)
 * Only dimensions with weight>0 AND total>0 contribute.
 */
export function scoreReport(
  dimensionScores: FitnessDimensionScore[],
  minScore = 80,
): FitnessReport {
  const allHardGateFailures: string[] = [];
  let weightedSum = 0;
  let totalWeight = 0;

  for (const ds of dimensionScores) {
    allHardGateFailures.push(...ds.hard_gate_failures);
    if (ds.weight > 0 && ds.total > 0) {
      weightedSum += ds.score * ds.weight;
      totalWeight += ds.weight;
    }
  }

  const final_score = totalWeight > 0 ? weightedSum / totalWeight : 0;

  return {
    dimensions: dimensionScores,
    final_score,
    hard_gate_blocked: allHardGateFailures.length > 0,
    score_blocked: totalWeight > 0 && final_score < minScore,
    runtime_timed_out: false,
  };
}

/**
 * Determine exit code from a fitness report.
 * Port of governance.rs::enforce.
 *
 * Returns:
 *   0 — pass
 *   1 — score below minimum threshold
 *   2 — hard gate failure or runtime timeout
 */
export function enforceExitCode(report: FitnessReport, minScore = 80): number {
  if (report.runtime_timed_out) {
    return 2;
  }

  if (report.hard_gate_blocked) {
    return 2;
  }

  const hasWeightedDimensions = report.dimensions.some((ds) => ds.weight > 0);
  if (hasWeightedDimensions && report.final_score < minScore) {
    return 1;
  }

  return 0;
}
