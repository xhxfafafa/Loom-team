/**
 * Node fitness engine — orchestrates the full fitness run.
 *
 * Replaces the Rust `entrix run` binary for the Web-only repo.
 *
 * Flow:
 * 1. Load config from docs/fitness/manifest.yaml + frontmatter
 * 2. Filter metrics by tier and scope
 * 3. Run each metric via shell spawn
 * 4. Score dimensions and compute final report
 * 5. Produce the snake_case report JSON + exit code
 *
 * The report shape is byte-for-byte compatible with the Rust entrix output:
 * {final_score, hard_gate_blocked, score_blocked, runtime_timed_out,
 *  dimensions:[{name,weight,score,passed,total,hard_gate_failures,
 *               results:[{name,passed,state,tier,hard_gate,duration_ms,output}]}]}
 */

import type {
  ExecutionScope,
  FitnessConfig,
  MetricDefinition,
  MetricTier,
} from "./fitness-config-loader";
import { filterByScope, filterByTier, loadFitnessConfig } from "./fitness-config-loader";
import { runMetrics } from "./fitness-metric-runner";
import type { FitnessDimensionScore, FitnessMetricResult, FitnessReport } from "./fitness-scoring";
import { enforceExitCode, scoreDimension, scoreReport } from "./fitness-scoring";

export type NodeFitnessRunResult = {
  generatedAt: string;
  repoRoot: string;
  tier: MetricTier;
  scope: ExecutionScope;
  command: string;
  args: string[];
  durationMs: number;
  exitCode: number;
  report: FitnessReport & {
    final_score: number;
    hard_gate_blocked: boolean;
    score_blocked: boolean;
    runtime_timed_out: boolean;
    dimensions: Array<{
      name: string;
      weight: number;
      score: number;
      passed: number;
      total: number;
      hard_gate_failures: string[];
      results: FitnessMetricResult[];
    }>;
  };
  /** Raw snake_case report for JSON output compatibility. */
  rawReport: Record<string, unknown>;
};

/**
 * Build the snake_case raw report object that matches the Rust entrix JSON output exactly.
 */
function buildRawReport(report: FitnessReport): Record<string, unknown> {
  return {
    final_score: report.final_score,
    hard_gate_blocked: report.hard_gate_blocked,
    score_blocked: report.score_blocked,
    runtime_timed_out: report.runtime_timed_out,
    dimensions: report.dimensions.map((dim) => ({
      name: dim.name,
      weight: dim.weight,
      score: dim.score,
      passed: dim.passed,
      total: dim.total,
      hard_gate_failures: dim.hard_gate_failures,
      results: dim.results.map((r) => ({
        name: r.name,
        passed: r.passed,
        state: r.state,
        tier: r.tier,
        hard_gate: r.hard_gate,
        duration_ms: r.duration_ms,
        output: r.output,
      })),
    })),
  };
}

/**
 * Execute a fitness run using the Node engine.
 *
 * @param repoRoot - Repository root directory
 * @param tier - Run tier (fast/normal/deep)
 * @param scope - Execution scope (local/ci/staging/prod_observation)
 * @param dimension - Optional single dimension name to run (filters config.dimensions)
 * @returns Complete run result with report and exit code
 */
export async function executeNodeFitnessRun(params: {
  repoRoot: string;
  tier: MetricTier;
  scope: ExecutionScope;
  dimension?: string;
}): Promise<NodeFitnessRunResult> {
  const startedAt = Date.now();

  // 1. Load configuration
  const config: FitnessConfig = loadFitnessConfig(params.repoRoot);

  // 1b. Optionally filter to a single dimension
  let dimensions = config.dimensions;
  if (params.dimension) {
    const match = dimensions.find((d) => d.name === params.dimension);
    if (!match) {
      const available = dimensions.map((d) => d.name).join(", ");
      throw new Error(
        `Unknown fitness dimension: "${params.dimension}". Available dimensions: ${available}`,
      );
    }
    dimensions = [match];
  }

  // 2. Filter and collect metrics per dimension
  const dimensionMetrics: Array<{
    dimension: { name: string; weight: number };
    metrics: MetricDefinition[];
  }> = [];

  for (const dim of dimensions) {
    const tierFiltered = filterByTier(dim.metrics, params.tier);
    const scopeFiltered = filterByScope(tierFiltered, params.scope);

    // Include dimension even if no metrics match (it will have 0 total)
    dimensionMetrics.push({
      dimension: { name: dim.name, weight: dim.weight },
      metrics: scopeFiltered,
    });
  }

  // 3. Run metrics for each dimension
  const dimensionScores: FitnessDimensionScore[] = [];

  for (const { dimension, metrics } of dimensionMetrics) {
    const results = metrics.length > 0
      ? await runMetrics(metrics, params.repoRoot)
      : [];

    const score = scoreDimension(results, dimension.name, dimension.weight);
    dimensionScores.push(score);
  }

  // 4. Score the overall report
  const report = scoreReport(dimensionScores);

  // 5. Determine exit code
  const exitCode = enforceExitCode(report);

  const durationMs = Date.now() - startedAt;
  const rawReport = buildRawReport(report);

  return {
    generatedAt: new Date().toISOString(),
    repoRoot: params.repoRoot,
    tier: params.tier,
    scope: params.scope,
    command: "node",
    args: params.dimension
      ? ["--import", "tsx", "src/core/fitness/node-fitness-engine.ts", "--dimension", params.dimension]
      : ["--import", "tsx", "src/core/fitness/node-fitness-engine.ts"],
    durationMs,
    exitCode,
    report: { ...report, ...rawReport } as NodeFitnessRunResult["report"],
    rawReport,
  };
}
