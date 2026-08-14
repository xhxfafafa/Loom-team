/**
 * Detector evaluation engine.
 * Ported from Rust detector.rs.
 *
 * Evaluates each DetectorDefinition against the filesystem to produce
 * CriterionResult objects.
 *
 * NOTE: Command-based detectors (command_exit_code, command_output_regex)
 * are implemented but restricted by ALLOWED_COMMAND_EXECUTABLES.
 * The codeowners_routing detector is stubbed to always fail in the TS
 * port because it depends on the routa_core Rust library.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

import { globSync } from "glob";
import yaml from "js-yaml";

import { buildRegex } from "./support";
import {
  ALLOWED_COMMAND_EXECUTABLES,
  DEFAULT_GLOB_IGNORE,
  MAX_REGEX_INPUT_LENGTH,
  type CriterionResult,
  type CriterionStatus,
  type DetectorDefinition,
  type FluencyCriterion,
  type PathSegment,
} from "./types";

// ---------------------------------------------------------------------------
// Evaluation context (caches file reads across criteria)
// ---------------------------------------------------------------------------

type DetectorResult = {
  status: CriterionStatus;
  detail: string;
  evidence: string[];
};

export class EvaluationContext {
  readonly repoRoot: string;
  private textCache = new Map<string, string>();
  private jsonCache = new Map<string, unknown>();
  private yamlCache = new Map<string, unknown>();

  constructor(repoRoot: string) {
    this.repoRoot = path.resolve(repoRoot);
  }

  readText(relativePath: string): string {
    const absolute = this.resolvePath(relativePath);
    const cached = this.textCache.get(absolute);
    if (cached !== undefined) return cached;

    const content = fs.readFileSync(absolute, "utf-8");
    this.textCache.set(absolute, content);
    return content;
  }

  readJson(relativePath: string): unknown {
    const absolute = this.resolvePath(relativePath);
    const cached = this.jsonCache.get(absolute);
    if (cached !== undefined) return cached;

    const content = fs.readFileSync(absolute, "utf-8");
    const parsed = JSON.parse(content);
    this.jsonCache.set(absolute, parsed);
    return parsed;
  }

  readYaml(relativePath: string): unknown {
    const absolute = this.resolvePath(relativePath);
    const cached = this.yamlCache.get(absolute);
    if (cached !== undefined) return cached;

    const content = fs.readFileSync(absolute, "utf-8");
    const parsed = yaml.load(content);
    this.yamlCache.set(absolute, parsed as unknown);
    return parsed;
  }

  resolvePath(relativePath: string): string {
    const candidate = path.resolve(relativePath);
    if (path.isAbsolute(relativePath)) return candidate;
    return path.join(this.repoRoot, relativePath);
  }

  pathExists(relativePath: string): boolean {
    try {
      fs.accessSync(this.resolvePath(relativePath));
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function evaluateCriterion(
  criterion: FluencyCriterion,
  context: EvaluationContext,
): CriterionResult {
  const detectorResult = evaluateDetector(criterion.detector, context);

  return {
    id: criterion.id,
    level: criterion.level,
    dimension: criterion.dimension,
    capabilityGroup: criterion.capabilityGroup,
    capabilityGroupName: null, // Set by engine after evaluation
    weight: criterion.weight,
    critical: criterion.critical,
    status: detectorResult.status,
    detectorType: criterion.detector.type,
    profiles: criterion.profiles,
    evidenceMode: criterion.evidenceMode,
    detail: detectorResult.detail,
    evidence: detectorResult.evidence,
    whyItMatters: criterion.whyItMatters,
    recommendedAction: criterion.recommendedAction,
    evidenceHint: criterion.evidenceHint,
  };
}

// ---------------------------------------------------------------------------
// Detector evaluation
// ---------------------------------------------------------------------------

function evaluateDetector(
  detector: DetectorDefinition,
  context: EvaluationContext,
): DetectorResult {
  switch (detector.type) {
    case "file_exists":
      return evaluateFileExists(detector.path, context);

    case "file_contains_regex":
      return evaluateFileContainsRegex(detector.path, detector.pattern, detector.flags, context);

    case "all_of":
      return evaluateAllOf(detector.detectors, context);

    case "any_of":
      return evaluateAnyOf(detector.detectors, context);

    case "any_file_exists":
      return evaluateAnyFileExists(detector.paths, context);

    case "codeowners_routing":
      return evaluateCodeownersRouting(context);

    case "glob_count":
      return evaluateGlobCount(detector.patterns, detector.min, context);

    case "glob_contains_regex":
      return evaluateGlobContainsRegex(
        detector.patterns, detector.pattern, detector.flags, detector.minMatches, context,
      );

    case "json_path_exists":
      return evaluateJsonPathExists(detector.path, detector.jsonPath, context);

    case "yaml_path_exists":
      return evaluateYamlPathExists(detector.path, detector.yamlPath, context);

    case "command_exit_code":
      return evaluateCommandExitCode(
        detector.command, detector.expectedExitCode, detector.timeoutMs, context,
      );

    case "command_output_regex":
      return evaluateCommandOutputRegex(
        detector.command, detector.pattern, detector.flags,
        detector.expectedExitCode, detector.timeoutMs, context,
      );

    case "manual_attestation":
      return {
        status: "skipped",
        detail: "manual attestation required: " + detector.prompt,
        evidence: [],
      };
  }
}

// ---------------------------------------------------------------------------
// Individual detector implementations
// ---------------------------------------------------------------------------

function evaluateFileExists(filePath: string, context: EvaluationContext): DetectorResult {
  const exists = context.pathExists(filePath);
  return {
    status: exists ? "pass" : "fail",
    detail: exists ? "found " + filePath : "missing " + filePath,
    evidence: exists ? [filePath] : [],
  };
}

function evaluateFileContainsRegex(
  filePath: string,
  pattern: string,
  flags: string,
  context: EvaluationContext,
): DetectorResult {
  try {
    const content = context.readText(filePath);
    const regex = buildRegex(pattern, flags, "file_contains_regex");
    const capped = content.length > MAX_REGEX_INPUT_LENGTH
      ? content.slice(0, MAX_REGEX_INPUT_LENGTH)
      : content;
    const passed = regex.test(capped);
    return {
      status: passed ? "pass" : "fail",
      detail: passed
        ? "content in " + filePath + " matched " + pattern
        : "content in " + filePath + " did not match " + pattern,
      evidence: passed ? [filePath] : [],
    };
  } catch (error) {
    return {
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      evidence: [],
    };
  }
}

function evaluateAllOf(
  detectors: DetectorDefinition[],
  context: EvaluationContext,
): DetectorResult {
  const evidence: string[] = [];
  let skippedCount = 0;

  for (const nested of detectors) {
    const result = evaluateDetector(nested, context);
    switch (result.status) {
      case "pass":
        evidence.push(...result.evidence);
        break;
      case "fail":
        return {
          status: "fail",
          detail: "required " + nested.type + " failed: " + result.detail,
          evidence,
        };
      case "skipped":
        skippedCount++;
        break;
    }
  }

  if (skippedCount === detectors.length) {
    return {
      status: "skipped",
      detail: "all required checks were skipped",
      evidence: [],
    };
  }

  if (skippedCount > 0) {
    return {
      status: "skipped",
      detail: "some required checks were skipped",
      evidence,
    };
  }

  evidence.length = Math.min(evidence.length, 10);
  return {
    status: "pass",
    detail: "all " + detectors.length + " required checks passed",
    evidence,
  };
}

function evaluateAnyOf(
  detectors: DetectorDefinition[],
  context: EvaluationContext,
): DetectorResult {
  const failures: string[] = [];
  let skippedCount = 0;

  for (const nested of detectors) {
    const result = evaluateDetector(nested, context);
    if (result.status === "pass") {
      return {
        status: "pass",
        detail: "matched " + nested.type + ": " + result.detail,
        evidence: result.evidence,
      };
    }
    if (result.status === "skipped") {
      skippedCount++;
    }
    failures.push(nested.type + ": " + result.detail);
  }

  if (skippedCount === detectors.length) {
    return {
      status: "skipped",
      detail: "all alternatives were skipped",
      evidence: [],
    };
  }

  return {
    status: "fail",
    detail: "all alternatives failed: " + failures.join(" | "),
    evidence: [],
  };
}

function evaluateAnyFileExists(
  paths: string[],
  context: EvaluationContext,
): DetectorResult {
  const matched = paths.filter((p) => context.pathExists(p));
  return {
    status: matched.length > 0 ? "pass" : "fail",
    detail: matched.length > 0
      ? "found " + matched.join(", ")
      : "missing all candidates: " + paths.join(", "),
    evidence: matched,
  };
}

function evaluateCodeownersRouting(_context: EvaluationContext): DetectorResult {
  // The codeowners_routing detector depends on the routa_core Rust library
  // for CODEOWNERS parsing and correlation. In the TS port, we always fail
  // this detector since the Rust dependency is not available.
  // This is documented as a known limitation.
  return {
    status: "fail",
    detail: "CODEOWNERS routing detection is not available in the TypeScript engine",
    evidence: [],
  };
}

function evaluateGlobCount(
  patterns: string[],
  min: number,
  context: EvaluationContext,
): DetectorResult {
  try {
    const matches = collectGlobMatches(patterns, context.repoRoot, false);
    return {
      status: matches.length >= min ? "pass" : "fail",
      detail: "matched " + matches.length + " paths (min " + min + ")",
      evidence: matches.slice(0, 10),
    };
  } catch (error) {
    return {
      status: "fail",
      detail: "glob failed: " + (error instanceof Error ? error.message : String(error)),
      evidence: [],
    };
  }
}

function evaluateGlobContainsRegex(
  patterns: string[],
  pattern: string,
  flags: string,
  minMatches: number,
  context: EvaluationContext,
): DetectorResult {
  try {
    const candidates = collectGlobMatches(patterns, context.repoRoot, true);
    const regex = buildRegex(pattern, flags, "glob_contains_regex");
    const matched: string[] = [];

    for (const candidate of candidates) {
      try {
        const content = context.readText(candidate);
        const capped = content.length > MAX_REGEX_INPUT_LENGTH
          ? content.slice(0, MAX_REGEX_INPUT_LENGTH)
          : content;
        if (regex.test(capped)) {
          matched.push(candidate);
        }
        if (matched.length >= minMatches) break;
      } catch {
        // Skip unreadable files
        continue;
      }
    }

    return {
      status: matched.length >= minMatches ? "pass" : "fail",
      detail: "regex matched " + matched.length + " files (min " + minMatches
        + ") across " + candidates.length + " candidates",
      evidence: matched.slice(0, 10),
    };
  } catch (error) {
    return {
      status: "fail",
      detail: "glob regex failed: " + (error instanceof Error ? error.message : String(error)),
      evidence: [],
    };
  }
}

function evaluateJsonPathExists(
  filePath: string,
  jsonPath: PathSegment[],
  context: EvaluationContext,
): DetectorResult {
  try {
    const document = context.readJson(filePath);
    const resolved = lookupPath(document, jsonPath);
    const pathLabel = pathSpecLabel(jsonPath);
    return {
      status: resolved !== undefined ? "pass" : "fail",
      detail: resolved !== undefined
        ? "found JSON path " + pathLabel + " in " + filePath
        : "missing JSON path " + pathLabel + " in " + filePath,
      evidence: resolved !== undefined ? [filePath] : [],
    };
  } catch (error) {
    return {
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      evidence: [],
    };
  }
}

function evaluateYamlPathExists(
  filePath: string,
  yamlPath: PathSegment[],
  context: EvaluationContext,
): DetectorResult {
  try {
    const document = context.readYaml(filePath);
    const resolved = lookupPath(document, yamlPath);
    const pathLabel = pathSpecLabel(yamlPath);
    return {
      status: resolved !== undefined ? "pass" : "fail",
      detail: resolved !== undefined
        ? "found YAML path " + pathLabel + " in " + filePath
        : "missing YAML path " + pathLabel + " in " + filePath,
      evidence: resolved !== undefined ? [filePath] : [],
    };
  } catch (error) {
    return {
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      evidence: [],
    };
  }
}

function evaluateCommandExitCode(
  command: string,
  expectedExitCode: number,
  timeoutMs: number,
  context: EvaluationContext,
): DetectorResult {
  try {
    const result = runCommand(command, context.repoRoot, timeoutMs);
    return {
      status: result.exitCode === expectedExitCode ? "pass" : "fail",
      detail: result.timedOut
        ? "command timed out after " + timeoutMs + "ms"
        : "exit code " + result.exitCode + ", expected " + expectedExitCode,
      evidence: result.output ? [result.output] : [],
    };
  } catch (error) {
    return {
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      evidence: [],
    };
  }
}

function evaluateCommandOutputRegex(
  command: string,
  pattern: string,
  flags: string,
  expectedExitCode: number,
  timeoutMs: number,
  context: EvaluationContext,
): DetectorResult {
  try {
    const result = runCommand(command, context.repoRoot, timeoutMs);
    const regex = buildRegex(pattern, flags, "command_output_regex");
    const passed = !result.timedOut
      && result.exitCode === expectedExitCode
      && regex.test(result.output);

    return {
      status: passed ? "pass" : "fail",
      detail: result.timedOut
        ? "command timed out after " + timeoutMs + "ms"
        : passed
          ? "command output matched " + pattern
          : "command output did not match " + pattern,
      evidence: result.output ? [result.output] : [],
    };
  } catch (error) {
    return {
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      evidence: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Glob helpers
// ---------------------------------------------------------------------------

function collectGlobMatches(
  patterns: string[],
  repoRoot: string,
  nodir: boolean,
): string[] {
  const matchSet = new Set<string>();

  for (const pattern of patterns) {
    const matches = globSync(pattern, {
      cwd: repoRoot,
      ignore: [...DEFAULT_GLOB_IGNORE],
      nodir,
      dot: true,
      absolute: false,
    });

    for (const match of matches) {
      // Normalize to forward slashes
      matchSet.add(match.split(path.sep).join("/"));
    }
  }

  const sorted = [...matchSet];
  sorted.sort();
  return sorted;
}

// ---------------------------------------------------------------------------
// Path navigation
// ---------------------------------------------------------------------------

function lookupPath(source: unknown, spec: PathSegment[]): unknown {
  let current: unknown = source;
  for (const segment of spec) {
    if (current == null || typeof current !== "object") return undefined;

    if (segment.kind === "key") {
      if (Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[segment.value];
    } else {
      if (!Array.isArray(current)) return undefined;
      current = current[segment.value];
    }
  }
  return current;
}

function pathSpecLabel(spec: PathSegment[]): string {
  return spec
    .map((segment) => (segment.kind === "key" ? segment.value : String(segment.value)))
    .join(".");
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

type CommandExecutionResult = {
  exitCode: number;
  output: string;
  timedOut: boolean;
};

function parseCommand(command: string): [string, string[]] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaping = false;

  for (const ch of command) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      continue;
    }

    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaping || quote !== null) {
    throw new Error("command contains unterminated escaping or quotes");
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    throw new Error("command must not be empty");
  }

  return [tokens[0], tokens.slice(1)];
}

function validateExecutable(executable: string): void {
  if (executable.includes("/") || executable.includes("\\")) {
    throw new Error(
      "command executable \"" + executable + "\" must be a bare allowlisted name",
    );
  }

  const commandName = path.basename(executable);
  if (!(ALLOWED_COMMAND_EXECUTABLES as readonly string[]).includes(commandName)) {
    throw new Error(
      "command executable \"" + commandName + "\" is not allowed",
    );
  }
}

function runCommand(
  command: string,
  repoRoot: string,
  timeoutMs: number,
): CommandExecutionResult {
  const [executable, args] = parseCommand(command);
  validateExecutable(executable);

  try {
    const output = execSync(executable + " " + args.map(shellEscape).join(" "), {
      cwd: repoRoot,
      timeout: timeoutMs,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      exitCode: 0,
      output: output.trim(),
      timedOut: false,
    };
  } catch (error: unknown) {
    if (error instanceof Error && "status" in error) {
      const execError = error as { status: number | null; stdout?: string; stderr?: string; killed?: boolean };
      const timedOut = execError.killed === true;
      const stdout = typeof execError.stdout === "string" ? execError.stdout : "";
      const stderr = typeof execError.stderr === "string" ? execError.stderr : "";
      return {
        exitCode: execError.status ?? 1,
        output: (stdout + stderr).trim(),
        timedOut,
      };
    }
    throw error;
  }
}

function shellEscape(arg: string): string {
  if (/^[a-zA-Z0-9_\-./:=@]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
