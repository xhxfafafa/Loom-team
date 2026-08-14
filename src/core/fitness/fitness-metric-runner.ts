/**
 * Fitness metric runner — spawns metric commands and evaluates results.
 *
 * Port of entrix ShellRunner:
 * - Commands run via /bin/bash -lc (shell: true equivalent).
 * - Per-metric timeout (default 300s), with process group kill on timeout.
 * - Regex pattern matching: if metric has a pattern, pass = exit 0 AND pattern matches.
 *   Non-zero exit with a pattern → state "unknown" (infra failure).
 * - Output truncation to 4000 chars head + 4000 tail.
 * - ENOENT / command not found → state "unknown".
 * - Skipped metrics (e.g. clippy_pass in Web-only repo) produce state "skipped".
 */

import { spawn } from "child_process";

import type { MetricDefinition } from "./fitness-config-loader";
import type { FitnessMetricResult, MetricState } from "./fitness-scoring";

/** Metrics that should be deterministically skipped in the Web-only repo. */
const SKIPPED_METRICS: ReadonlySet<string> = new Set([
  "clippy_pass",
]);

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_OUTPUT_CHARS = 4000;

/**
 * Truncate output preserving head and tail, similar to Rust smart_truncate.
 * Total max ~8200 chars (4000 head + 200 separator + 4000 tail).
 */
function truncateOutput(text: string): string {
  const maxBytes = MAX_OUTPUT_CHARS * 2 + 200;
  if (text.length <= maxBytes) {
    return text;
  }

  const head = text.slice(0, MAX_OUTPUT_CHARS);
  const tail = text.slice(text.length - MAX_OUTPUT_CHARS);
  const omitted = text.length - MAX_OUTPUT_CHARS * 2;
  return `${head}\n\n... [${omitted} characters omitted] ...\n\n${tail}`;
}

/**
 * Detect infra-level failures that should produce "unknown" state rather than "fail".
 * Mirrors Rust is_infra_fatal logic.
 */
function isInfraFailure(
  command: string,
  output: string,
  exitCode: number | null,
  patternMismatch: boolean,
): boolean {
  if (patternMismatch) {
    return true;
  }

  const loweredOutput = output.toLowerCase();
  if (
    exitCode === 127
    || loweredOutput.includes("command not found")
    || loweredOutput.includes("not recognized as an internal or external command")
  ) {
    return true;
  }

  if (command.toLowerCase().includes("npm audit")) {
    const infraNeedles = [
      "getaddrinfo enotfound",
      "eai_again",
      "econreset",
      "etimedout",
      "network request failed",
      "audit endpoint returned an error",
    ];
    if (infraNeedles.some((needle) => loweredOutput.includes(needle))) {
      return true;
    }
  }

  return false;
}

type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
};

function spawnMetricCommand(
  command: string,
  repoRoot: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
      },
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({
        stdout,
        stderr,
        exitCode: null,
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    child.on("close", (code, signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        timedOut = true;
      }
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === "number" ? code : null,
        timedOut,
      });
    });

    // Also detect timeout via the timeout event (Node.js child_process)
    child.on("exit", (_code, signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        timedOut = true;
      }
    });
  });
}

/**
 * Run a single metric and produce a MetricResult.
 *
 * @param metric - The metric definition from frontmatter
 * @param repoRoot - Repository root directory
 * @returns Metric result with state, passed, output, duration
 */
export async function runMetric(
  metric: MetricDefinition,
  repoRoot: string,
): Promise<FitnessMetricResult> {
  const startedAt = Date.now();

  // Check if this metric should be skipped (e.g., Rust-only metrics in Web-only repo)
  if (SKIPPED_METRICS.has(metric.name)) {
    return {
      name: metric.name,
      passed: false,
      state: "skipped" as MetricState,
      tier: metric.tier,
      hard_gate: false, // Skipped metrics don't trigger hard gate
      duration_ms: 0,
      output: `[SKIPPED] ${metric.name} is a Rust-only metric and is not applicable in the Web-only repository. The Rust toolchain has been removed.`,
    };
  }

  const timeoutSeconds = metric.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
  const timeoutMs = timeoutSeconds * 1000;

  const result = await spawnMetricCommand(metric.command, repoRoot, timeoutMs);
  const duration_ms = Date.now() - startedAt;
  const combined = `${result.stdout}${result.stderr}`;
  const output = truncateOutput(combined);

  // Timeout → fail
  if (result.timedOut) {
    const timeoutHeader = `TIMEOUT (${timeoutSeconds}s)`;
    const timedOutOutput = output.trim()
      ? `${timeoutHeader}\n${output}`
      : timeoutHeader;

    return {
      name: metric.name,
      passed: false,
      state: "fail" as MetricState,
      tier: metric.tier,
      hard_gate: metric.hard_gate,
      duration_ms,
      output: timedOutOutput,
    };
  }

  // Spawn error (ENOENT etc.) → unknown
  if (result.error) {
    return {
      name: metric.name,
      passed: false,
      state: "unknown" as MetricState,
      tier: metric.tier,
      hard_gate: metric.hard_gate,
      duration_ms,
      output: result.error,
    };
  }

  const exitCode = result.exitCode;
  const exitSuccess = exitCode === 0;

  // Pattern matching logic (mirrors Rust runner.rs)
  let patternMatched = false;
  if (metric.pattern) {
    try {
      const regex = new RegExp(metric.pattern);
      patternMatched = regex.test(combined);
    } catch {
      // Invalid regex → treat as no match
      patternMatched = false;
    }
  }

  const hasPattern = Boolean(metric.pattern);
  const passed = hasPattern ? exitSuccess && patternMatched : exitSuccess;

  // Determine state
  let state: MetricState;
  if (passed) {
    state = "pass";
  } else if (
    isInfraFailure(
      metric.command,
      combined,
      exitCode,
      !exitSuccess && hasPattern && !patternMatched,
    )
  ) {
    state = "unknown";
  } else {
    state = "fail";
  }

  return {
    name: metric.name,
    passed,
    state,
    tier: metric.tier,
    hard_gate: metric.hard_gate,
    duration_ms,
    output,
  };
}

/**
 * Run multiple metrics sequentially and collect results.
 */
export async function runMetrics(
  metrics: MetricDefinition[],
  repoRoot: string,
): Promise<FitnessMetricResult[]> {
  const results: FitnessMetricResult[] = [];
  for (const metric of metrics) {
    results.push(await runMetric(metric, repoRoot));
  }
  return results;
}
