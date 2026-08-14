/**
 * File budget checker — CLI wrapper around the file budget logic from automations.ts.
 *
 * Web-only replacement for the former Rust CLI's `harness budget` command.
 *
 * Usage:
 *   node --import tsx scripts/fitness/check-file-budget.ts [options]
 *
 * Options:
 *   --config <path>     Path to file_budgets.json (default: docs/fitness/file_budgets.json)
 *   --changed-only      Only check files changed vs base ref
 *   --base <ref>        Git base ref for --changed-only (default: HEAD)
 *   --overrides-only    Only check files that have explicit budget overrides
 *   --repo-root <path>  Repository root (default: process.cwd())
 *
 * Output contract (matches Rust harness budget stdout):
 *   file_budget_checked: N
 *   file_budget_violations: N
 *   [violation details...]
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import {
  DEFAULT_FILE_BUDGETS,
  loadFileBudgets,
  resolveBudget,
  shouldIncludeFile,
  walkFiles,
  type FileBudgetConfig,
} from "@/core/harness/automations";

type CliArgs = {
  configPath?: string;
  changedOnly: boolean;
  baseRef: string;
  overridesOnly: boolean;
  repoRoot: string;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    changedOnly: false,
    baseRef: process.env.ROUTA_FITNESS_CHANGED_BASE ?? "HEAD",
    overridesOnly: false,
    repoRoot: process.cwd(),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" && i + 1 < argv.length) {
      args.configPath = argv[++i];
    } else if (arg === "--changed-only") {
      args.changedOnly = true;
    } else if (arg === "--base" && i + 1 < argv.length) {
      args.baseRef = argv[++i];
    } else if (arg === "--overrides-only") {
      args.overridesOnly = true;
    } else if (arg === "--repo-root" && i + 1 < argv.length) {
      args.repoRoot = argv[++i];
    }
  }

  return args;
}

function getChangedFiles(repoRoot: string, baseRef: string): Set<string> {
  try {
    const output = execSync(
      `git diff --name-only --diff-filter=ACMR "${baseRef}" -- . 2>/dev/null`,
      { cwd: repoRoot, encoding: "utf-8", timeout: 30_000 },
    );
    const files = output
      .trim()
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    return new Set(files);
  } catch {
    return new Set();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(args.repoRoot);

  // Load budgets
  const warnings: string[] = [];
  let config: FileBudgetConfig;

  if (args.configPath) {
    const configAbs = path.isAbsolute(args.configPath)
      ? args.configPath
      : path.join(repoRoot, args.configPath);
    if (!fs.existsSync(configAbs)) {
      warnings.push(`Config not found: ${configAbs}; using defaults.`);
      config = DEFAULT_FILE_BUDGETS;
    } else {
      try {
        const raw = fs.readFileSync(configAbs, "utf-8");
        const parsed = JSON.parse(raw);
        config = {
          ...DEFAULT_FILE_BUDGETS,
          ...parsed,
          extension_max_lines: {
            ...(DEFAULT_FILE_BUDGETS.extension_max_lines ?? {}),
            ...(parsed.extension_max_lines ?? {}),
          },
          overrides: Array.isArray(parsed.overrides) ? parsed.overrides : [],
        };
      } catch {
        warnings.push(`Failed to parse config; using defaults.`);
        config = DEFAULT_FILE_BUDGETS;
      }
    }
  } else {
    config = await loadFileBudgets(repoRoot, warnings);
  }

  // Determine which files to check
  let candidatePaths: string[];

  if (args.changedOnly) {
    const changedFiles = getChangedFiles(repoRoot, args.baseRef);
    candidatePaths = Array.from(changedFiles);
  } else {
    // Scan all files under include_roots
    const allFiles: string[] = [];
    const includeRoots = config.include_roots ?? DEFAULT_FILE_BUDGETS.include_roots ?? [];
    for (const root of includeRoots) {
      const absRoot = path.join(repoRoot, root);
      if (fs.existsSync(absRoot) && fs.statSync(absRoot).isDirectory()) {
        walkFiles(absRoot, allFiles);
      }
    }
    candidatePaths = allFiles.map((abs) => path.relative(repoRoot, abs).replace(/\\/g, "/"));
  }

  // Filter to includable files
  const checkedPaths = candidatePaths.filter((rel) => shouldIncludeFile(rel, config));

  // If --overrides-only, further filter to files with explicit overrides
  const overrides = config.overrides ?? [];
  const overridePaths = new Set(overrides.map((o) => o.path).filter(Boolean));

  const filesToCheck = args.overridesOnly
    ? checkedPaths.filter((rel) => overridePaths.has(rel))
    : checkedPaths;

  // Check budgets
  const violations: Array<{ path: string; lineCount: number; budgetLimit: number }> = [];

  for (const relPath of filesToCheck) {
    const absPath = path.join(repoRoot, relPath);
    let source: string;
    try {
      source = fs.readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }

    const extension = path.extname(relPath).toLowerCase();
    const lineCount = source.split(/\r?\n/).length;
    const { budgetLimit } = resolveBudget(relPath, extension, config);

    if (lineCount > budgetLimit) {
      violations.push({ path: relPath, lineCount, budgetLimit });
    }
  }

  // Output (matches Rust harness budget stdout contract)
  console.log(`file_budget_checked: ${filesToCheck.length}`);
  console.log(`file_budget_violations: ${violations.length}`);

  for (const v of violations) {
    console.log(
      `  VIOLATION: ${v.path} (${v.lineCount} lines, budget ${v.budgetLimit})`,
    );
  }

  if (warnings.length > 0) {
    for (const w of warnings) {
      console.error(`warning: ${w}`);
    }
  }

  process.exit(violations.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`check-file-budget failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
