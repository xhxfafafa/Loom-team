#!/usr/bin/env node
/**
 * Node fitness CLI — replaces the `entrix run` binary for CI and local use.
 *
 * Usage:
 *   node --import tsx scripts/fitness/run-fitness.ts [options]
 *
 * Options:
 *   --dimension <name>   Run a single fitness dimension (e.g. api_contract)
 *   --tier <tier>        fast | normal | deep           (default: normal)
 *   --scope <scope>      local | ci | staging | prod_observation  (default: ci)
 *   --min-score <n>      Minimum score threshold       (default: 80)
 *   --output <path>      Write the snake_case report JSON to <path>
 *   --parallel           Accepted and ignored (metrics run sequentially;
 *                        each metric is an independent shell spawn)
 *
 * Exit codes (from fitness-scoring.ts enforceExitCode):
 *   0 — pass
 *   1 — score below minimum threshold
 *   2 — hard gate failure or runtime timeout
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExecutionScope, MetricTier } from "../../src/core/fitness/fitness-config-loader";
import { executeNodeFitnessRun } from "../../src/core/fitness/node-fitness-engine";
import type { FitnessReport } from "../../src/core/fitness/fitness-scoring";
import { enforceExitCode } from "../../src/core/fitness/fitness-scoring";
import { fromRoot } from "../lib/paths";

// ─────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────

type CliOptions = {
  dimension?: string;
  tier: MetricTier;
  scope: ExecutionScope;
  minScore: number;
  output?: string;
  parallel: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    tier: "normal",
    scope: "ci",
    minScore: 80,
    parallel: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dimension": {
        const val = argv[++i];
        if (!val) throw new Error("--dimension requires a value");
        opts.dimension = val;
        break;
      }
      case "--tier": {
        const val = argv[++i];
        if (val !== "fast" && val !== "normal" && val !== "deep") {
          throw new Error(`--tier must be fast|normal|deep, got: ${val}`);
        }
        opts.tier = val;
        break;
      }
      case "--scope": {
        const val = argv[++i];
        if (val !== "local" && val !== "ci" && val !== "staging" && val !== "prod_observation") {
          throw new Error(`--scope must be local|ci|staging|prod_observation, got: ${val}`);
        }
        opts.scope = val;
        break;
      }
      case "--min-score": {
        const val = argv[++i];
        const n = Number(val);
        if (Number.isNaN(n)) throw new Error(`--min-score must be a number, got: ${val}`);
        opts.minScore = n;
        break;
      }
      case "--output": {
        const val = argv[++i];
        if (!val) throw new Error("--output requires a value");
        opts.output = val;
        break;
      }
      case "--parallel": {
        // Accepted and ignored — metrics run sequentially via independent shell spawns.
        opts.parallel = true;
        break;
      }
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return opts;
}

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = fromRoot();

  console.error(
    `[fitness] running dimension=${opts.dimension ?? "(all)"} tier=${opts.tier} scope=${opts.scope} min-score=${opts.minScore}`,
  );

  const result = await executeNodeFitnessRun({
    repoRoot,
    tier: opts.tier,
    scope: opts.scope,
    dimension: opts.dimension,
  });

  // Write report JSON if --output specified
  if (opts.output) {
    const outPath = path.isAbsolute(opts.output) ? opts.output : path.join(repoRoot, opts.output);
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    fs.writeFileSync(outPath, JSON.stringify(result.rawReport, null, 2), "utf-8");
    console.error(`[fitness] report written to ${outPath}`);
  }

  // Human summary to stdout
  const raw = result.rawReport as FitnessReport;
  const dims = raw.dimensions ?? [];
  const summaryLines = dims.map(
    (d) => `  ${d.name}: score=${d.score.toFixed(1)} passed=${d.passed}/${d.total}`,
  );
  console.log(
    [
      `Fitness ${opts.dimension ?? "all"}: final_score=${raw.final_score.toFixed(1)} ` +
        `hard_gate_blocked=${raw.hard_gate_blocked} score_blocked=${raw.score_blocked}`,
      ...summaryLines,
    ].join("\n"),
  );

  // Exit code from scoring
  const exitCode = enforceExitCode(raw, opts.minScore);
  process.exit(exitCode);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[fitness] fatal: ${message}`);
  process.exit(2);
});
