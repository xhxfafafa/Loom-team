#!/usr/bin/env node

/**
 * Backend-core architecture suite runner (TypeScript).
 *
 * Web-only port of the former Rust CLI's `fitness arch-dsl --report backend-core-suite` command.
 * Loads the architecture DSL, executes the requested suite against the
 * TypeScript dependency graph analyzer (file-level fast mode), and emits
 * the same camelCase suite report the Rust CLI produced:
 *
 *   - `--json` prints the report JSON (consumed by /api/fitness/architecture
 *     and the fitness metric pattern `"summaryStatus": "(pass|skipped)"`).
 *   - Exit code 1 when summaryStatus is "fail" or the DSL cannot be loaded.
 *
 * The historical `--report <name>` flag is accepted and ignored.
 */

import fs from "node:fs";
import path from "node:path";

import { isDirectExecution } from "../lib/cli";
import {
  defaultArchitectureDslPath,
  loadArchitectureDslFile,
} from "./architecture-rule-dsl";
import {
  analyzeDependencyGraph,
  type GraphAnalysisLanguage,
  type GraphAnalyzerResult,
} from "../../src/core/graph/dependency-graph-analyzer";

type SuiteName = "boundaries" | "cycles";
type SummaryStatus = "pass" | "fail" | "skipped";
type Executor = "graph" | "archunitts" | null;

type SuiteViolation =
  | { kind: "dependency"; source: string; target: string; edgeCount: number }
  | { kind: "cycle"; path: string[]; edgeCount: number }
  | { kind: "unknown"; summary: string };

type SuiteRuleResult = {
  id: string;
  title: string;
  suite: SuiteName;
  status: "pass" | "fail";
  violationCount: number;
  violations: SuiteViolation[];
};

type BackendCoreSuiteReport = {
  generatedAt: string;
  repoRoot: string;
  suite: SuiteName;
  summaryStatus: SummaryStatus;
  archUnitSource: string | null;
  tsconfigPath: string;
  ruleCount: number;
  failedRuleCount: number;
  results: SuiteRuleResult[];
  notes: string[];
};

type DslDocument = Awaited<ReturnType<typeof loadArchitectureDslFile>>["document"];
type DslRule = DslDocument["rules"][number];
type DslSelector = DslDocument["selectors"][string];

function parseArgs(argv: string[]): {
  repoRoot: string;
  suite: SuiteName;
  json: boolean;
  dslPath: string;
} {
  let repoRoot = process.cwd();
  let suite: SuiteName = "boundaries";
  let json = false;
  let dslPath = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      repoRoot = path.resolve(argv[index + 1] ?? "");
      index += 1;
    } else if (arg.startsWith("--repo-root=")) {
      repoRoot = path.resolve(arg.slice("--repo-root=".length));
    } else if (arg === "--suite") {
      suite = parseSuite(argv[index + 1] ?? "");
      index += 1;
    } else if (arg.startsWith("--suite=")) {
      suite = parseSuite(arg.slice("--suite=".length));
    } else if (arg === "--dsl") {
      dslPath = argv[index + 1] ?? "";
      index += 1;
    } else if (arg.startsWith("--dsl=")) {
      dslPath = arg.slice("--dsl=".length);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--report") {
      index += 1; // legacy flag, no longer meaningful
    }
  }

  return {
    repoRoot,
    suite,
    json,
    dslPath: dslPath ? path.resolve(repoRoot, dslPath) : defaultArchitectureDslPath(repoRoot),
  };
}

function parseSuite(value: string): SuiteName {
  if (value === "boundaries" || value === "cycles") {
    return value;
  }
  throw new Error(`invalid suite '${value}' (expected boundaries or cycles)`);
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "*") {
      source += ".*";
      index += 1;
    } else if (char === "?") {
      source += ".";
      index += 1;
    } else if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close === -1) {
        source += "\\[";
        index += 1;
      } else {
        source += `[${pattern.slice(index + 1, close)}]`;
        index = close + 1;
      }
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      index += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

function selectorMatches(selector: DslSelector, value: string): boolean {
  const included = selector.include.some((pattern) => globToRegExp(pattern).test(value));
  const excluded = (selector.exclude ?? []).some((pattern) =>
    globToRegExp(pattern).test(value),
  );
  return included && !excluded;
}

function referencedSelectors(rule: DslRule, document: DslDocument): DslSelector[] {
  const ids = rule.kind === "dependency" ? [rule.from, rule.to] : [rule.scope];
  return ids.map((id) => document.selectors[id]);
}

function ruleGraphLanguage(rule: DslRule, document: DslDocument): GraphAnalysisLanguage | null {
  const languages = new Set(
    referencedSelectors(rule, document).map((selector) => selector.language),
  );
  if (languages.size !== 1) {
    return null;
  }
  const language = [...languages][0];
  return language === "rust" ? "rust" : "typescript";
}

function selectExecutor(rule: DslRule, document: DslDocument): Executor {
  const hints = rule.engine_hints?.length ? rule.engine_hints : ["archunitts"];
  if (hints.includes("graph") && ruleGraphLanguage(rule, document)) {
    return "graph";
  }
  if (
    hints.includes("archunitts") &&
    referencedSelectors(rule, document).every(
      (selector) => selector.language === "typescript" && selector.include.length === 1,
    )
  ) {
    return "archunitts";
  }
  return null;
}

function resolveGraphRoot(repoRoot: string, document: DslDocument): string {
  const rawRoot = document.defaults?.root?.trim();
  if (!rawRoot) {
    return repoRoot;
  }
  const candidate = path.isAbsolute(rawRoot) ? rawRoot : path.join(repoRoot, rawRoot);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw new Error(`defaults.root path is not a directory: ${candidate}`);
  }
  return candidate;
}

function executeDependencyRule(
  rule: Extract<DslRule, { kind: "dependency" }>,
  document: DslDocument,
  graph: GraphAnalyzerResult,
): SuiteViolation[] {
  const fromSelector = document.selectors[rule.from];
  const toSelector = document.selectors[rule.to];
  const counts = new Map<string, { source: string; target: string; edgeCount: number }>();

  for (const edge of graph.edges) {
    if (!selectorMatches(fromSelector, edge.from)) continue;
    if (!selectorMatches(toSelector, edge.to)) continue;
    const key = edge.from + " -> " + edge.to;
    const known = counts.get(key);
    if (known) {
      known.edgeCount += 1;
    } else {
      counts.set(key, { source: edge.from, target: edge.to, edgeCount: 1 });
    }
  }

  return [...counts.values()]
    .sort((left, right) =>
      left.source < right.source
        ? -1
        : left.source > right.source
          ? 1
          : left.target < right.target
            ? -1
            : left.target > right.target
              ? 1
              : 0,
    )
    .map((value) => ({ kind: "dependency" as const, ...value }));
}

function executeCycleRule(
  rule: Extract<DslRule, { kind: "cycle" }>,
  document: DslDocument,
  graph: GraphAnalyzerResult,
): SuiteViolation[] {
  const scopeSelector = document.selectors[rule.scope];
  const scopedNodes = graph.nodes
    .filter((node) => selectorMatches(scopeSelector, node.path))
    .map((node) => node.id)
    .sort();
  const scopedSet = new Set(scopedNodes);

  const adjacency = new Map<string, string[]>();
  for (const nodeId of scopedNodes) {
    adjacency.set(nodeId, []);
  }
  for (const edge of graph.edges) {
    if (!scopedSet.has(edge.from) || !scopedSet.has(edge.to)) continue;
    adjacency.get(edge.from)?.push(edge.to);
  }
  for (const targets of adjacency.values()) {
    targets.sort();
    const deduped = targets.filter((target, index) => index === 0 || target !== targets[index - 1]);
    deduped.forEach((target, index) => {
      targets[index] = target;
    });
    targets.length = deduped.length;
  }

  // Tarjan strongly-connected components over the scoped subgraph.
  let visitIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const strongConnect = (nodeId: string): void => {
    indices.set(nodeId, visitIndex);
    lowLinks.set(nodeId, visitIndex);
    visitIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const neighbor of adjacency.get(nodeId) ?? []) {
      if (!indices.has(neighbor)) {
        strongConnect(neighbor);
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId) ?? 0, lowLinks.get(neighbor) ?? 0));
      } else if (onStack.has(neighbor)) {
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId) ?? 0, indices.get(neighbor) ?? 0));
      }
    }

    if (lowLinks.get(nodeId) === indices.get(nodeId)) {
      const component: string[] = [];
      for (;;) {
        const memberId = stack.pop();
        if (!memberId) break;
        onStack.delete(memberId);
        component.push(memberId);
        if (memberId === nodeId) break;
      }
      component.sort();
      components.push(component);
    }
  };

  for (const nodeId of scopedNodes) {
    if (!indices.has(nodeId)) {
      strongConnect(nodeId);
    }
  }

  const violations: SuiteViolation[] = [];
  for (const component of components) {
    if (component.length > 1) {
      violations.push({ kind: "cycle", path: component, edgeCount: component.length });
    } else if (component.length === 1) {
      const nodeId = component[0];
      const hasSelfEdge = (adjacency.get(nodeId) ?? []).includes(nodeId);
      if (hasSelfEdge) {
        violations.push({ kind: "cycle", path: [nodeId, nodeId], edgeCount: 2 });
      }
    }
  }
  return violations;
}

function executeRule(
  rule: DslRule,
  document: DslDocument,
  graphFor: (language: GraphAnalysisLanguage) => GraphAnalyzerResult,
): SuiteViolation[] {
  const executor = selectExecutor(rule, document);
  if (executor === "graph") {
    const language = ruleGraphLanguage(rule, document);
    if (!language) {
      return [
        {
          kind: "unknown",
          summary: "graph rule '" + rule.id + "' has no resolvable language",
        },
      ];
    }
    const graph = graphFor(language);
    return rule.kind === "dependency"
      ? executeDependencyRule(rule, document, graph)
      : executeCycleRule(rule, document, graph);
  }
  if (executor === "archunitts") {
    return [
      {
        kind: "unknown",
        summary: "archunitts rules are intentionally executed via the TypeScript fitness path",
      },
    ];
  }
  return [{ kind: "unknown", summary: "rule execution result is missing" }];
}

function buildSuiteReport(options: {
  repoRoot: string;
  suite: SuiteName;
  document: DslDocument;
  graphFor: (language: GraphAnalysisLanguage) => GraphAnalyzerResult;
}): BackendCoreSuiteReport {
  const { repoRoot, suite, document, graphFor } = options;

  const results: SuiteRuleResult[] = document.rules
    .filter((rule) => rule.suite === suite)
    .map((rule) => {
      const violations = executeRule(rule, document, graphFor);
      return {
        id: rule.id,
        title: rule.title,
        suite,
        status: violations.length > 0 ? ("fail" as const) : ("pass" as const),
        violationCount: violations.length,
        violations,
      };
    });

  const notes: string[] = [];
  const hasArchUnitTs = document.rules.some(
    (rule) => selectExecutor(rule, document) === "archunitts",
  );
  if (hasArchUnitTs) {
    notes.push(
      "ArchUnitTS-compatible rules are planned here but still execute through scripts/fitness/check-backend-architecture.ts",
    );
  }

  const failedRuleCount = results.filter((result) => result.status === "fail").length;
  const summaryStatus: SummaryStatus =
    results.length === 0 ? "skipped" : failedRuleCount > 0 ? "fail" : "pass";

  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    suite,
    summaryStatus,
    archUnitSource:
      results.length > 0 ? "scripts/fitness/check-backend-architecture.ts" : null,
    tsconfigPath: path.join(repoRoot, "tsconfig.json"),
    ruleCount: results.length,
    failedRuleCount,
    results,
    notes,
  };
}

function formatTextReport(report: BackendCoreSuiteReport): string {
  const lines: string[] = [];
  lines.push("Architecture suite: " + report.suite);
  lines.push("Summary status: " + report.summaryStatus);
  if (report.archUnitSource) {
    lines.push("Runner source: " + report.archUnitSource);
  }
  for (const note of report.notes) {
    lines.push("Note: " + note);
  }
  for (const result of report.results) {
    lines.push(
      (result.status === "pass" ? "PASS" : "FAIL") +
        " " +
        result.id +
        " (" +
        result.violationCount +
        ")",
    );
    for (const violation of result.violations.slice(0, 5)) {
      if (violation.kind === "dependency") {
        lines.push(
          "  - " + violation.source + " -> " + violation.target + " (" + violation.edgeCount + ")",
        );
      } else if (violation.kind === "cycle") {
        lines.push("  - cycle: " + violation.path.join(" | "));
      } else {
        lines.push("  - " + violation.summary);
      }
    }
  }
  return lines.join("\n") + "\n";
}

export async function main(argv: string[]): Promise<number> {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let document: DslDocument;
  try {
    ({ document } = await loadArchitectureDslFile(options.dslPath));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let graphRoot: string;
  try {
    graphRoot = resolveGraphRoot(options.repoRoot, document);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const graphCache = new Map<GraphAnalysisLanguage, GraphAnalyzerResult>();
  const graphFor = (language: GraphAnalysisLanguage): GraphAnalyzerResult => {
    const cached = graphCache.get(language);
    if (cached) {
      return cached;
    }
    const graph = analyzeDependencyGraph(graphRoot, language, "fast");
    graphCache.set(language, graph);
    return graph;
  };

  const report = buildSuiteReport({
    repoRoot: options.repoRoot,
    suite: options.suite,
    document,
    graphFor,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(formatTextReport(report));
  }

  return report.summaryStatus === "fail" ? 1 : 0;
}

if (isDirectExecution(import.meta.url)) {
  main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
