#!/usr/bin/env node

/**
 * Harness Fluency CLI (TypeScript port).
 *
 * This script is the Node entry point for the harness fluency fitness engine,
 * replacing the previous `cargo run -p routa-cli -- fitness fluency` invocation.
 *
 * Usage:
 *   node --import tsx scripts/fitness/harness-fluency.ts [options]
 *
 * Options:
 *   --format <json|text>   Output format (default: json)
 *   --profile <name>       Profile to run (generic, agent_orchestrator)
 *   --mode <mode>          Execution mode (deterministic, hybrid, ai)
 *   --compare-last         Compare with the previous snapshot
 *   --no-save              Skip saving the snapshot
 *   --repo-root <path>     Repository root (default: current working directory)
 *
 * ## Known limitations vs the Rust engine:
 *
 * 1. hybrid/ai modes degrade to deterministic execution. The Rust engine
 *    shells out to the `claude` CLI for AI-enhanced scoring; this TS port
 *    does not invoke any external LLM.
 *
 * 2. codeowners_routing detector always fails because it depends on the
 *    routa_core Rust library for CODEOWNERS parsing.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { isDirectExecution } from "../lib/cli";
import {
  evaluateHarnessFluency,
  formatTextReport,
} from "../../src/core/fitness/fluency/index";
import type { EvaluateOptions } from "../../src/core/fitness/fluency/types";

type OutputFormat = "json" | "text";
type CliArgs = {
  format: OutputFormat;
  profile: string;
  mode: "deterministic" | "hybrid" | "ai";
  compareLast: boolean;
  noSave: boolean;
  repoRoot: string;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    format: "json",
    profile: "generic",
    mode: "deterministic",
    compareLast: false,
    noSave: false,
    repoRoot: process.cwd(),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--format":
        {
          const value = argv[++i];
          if (value === "json" || value === "text") {
            args.format = value;
          } else {
            throw new Error(`Invalid format: ${value}. Expected "json" or "text".`);
          }
        }
        break;
      case "--profile":
        args.profile = argv[++i];
        break;
      case "--mode":
        {
          const value = argv[++i];
          if (value === "deterministic" || value === "hybrid" || value === "ai") {
            args.mode = value;
          } else {
            throw new Error(`Invalid mode: ${value}. Expected "deterministic", "hybrid", or "ai".`);
          }
        }
        break;
      case "--compare-last":
        args.compareLast = true;
        break;
      case "--no-save":
        args.noSave = true;
        break;
      case "--repo-root":
        args.repoRoot = path.resolve(argv[++i]);
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown flag: ${arg}`);
        }
        break;
    }
  }

  return args;
}

function resolveModelPath(repoRoot: string, profile: string): string {
  if (profile === "agent_orchestrator") {
    return path.join(repoRoot, "docs/fitness/harness-fluency.profile.agent_orchestrator.yaml");
  }
  return path.join(repoRoot, "docs/fitness/harness-fluency.model.yaml");
}

function resolveSnapshotPath(repoRoot: string, profile: string): string {
  if (profile === "agent_orchestrator") {
    return path.join(repoRoot, "docs/fitness/reports/harness-fluency-agent-orchestrator-latest.json");
  }
  return path.join(repoRoot, "docs/fitness/reports/harness-fluency-latest.json");
}

export function runHarnessFluencyCli(args: CliArgs): number {
  if (!fs.existsSync(args.repoRoot) || !fs.statSync(args.repoRoot).isDirectory()) {
    process.stderr.write(`Error: repo root does not exist or is not a directory: ${args.repoRoot}\n`);
    return 1;
  }

  const modelPath = resolveModelPath(args.repoRoot, args.profile);
  if (!fs.existsSync(modelPath)) {
    process.stderr.write(`Error: model file not found: ${modelPath}\n`);
    return 1;
  }

  const snapshotPath = resolveSnapshotPath(args.repoRoot, args.profile);

  const options: EvaluateOptions = {
    repoRoot: args.repoRoot,
    modelPath,
    profile: args.profile,
    mode: args.mode,
    framing: "fluency",
    snapshotPath,
    compareLast: args.compareLast,
    save: !args.noSave,
  };

  try {
    const report = evaluateHarnessFluency(options);

    if (args.format === "json") {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(formatTextReport(report) + "\n");
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    return 1;
  }
}

// Direct execution entry point
if (isDirectExecution(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const exitCode = runHarnessFluencyCli(args);
    process.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}
