/**
 * Fitness configuration loader — port of entrix evidence loading.
 *
 * Parses docs/fitness/manifest.yaml and loads each referenced metric doc's
 * YAML frontmatter into typed metric/dimension configuration.
 */

import * as fs from "fs";
import * as path from "path";

import yaml from "js-yaml";

export type MetricTier = "fast" | "normal" | "deep";
export type ExecutionScope = "local" | "ci" | "staging" | "prod_observation";

export type MetricDefinition = {
  name: string;
  command: string;
  pattern?: string;
  hard_gate: boolean;
  tier: MetricTier;
  timeout_seconds?: number;
  execution_scope?: ExecutionScope;
  description?: string;
  gate?: string;
};

export type DimensionDefinition = {
  name: string;
  weight: number;
  tier: MetricTier;
  metrics: MetricDefinition[];
  sourceFile: string;
};

export type FitnessConfig = {
  dimensions: DimensionDefinition[];
};

type RawMetricFrontmatter = {
  name?: string;
  command?: string;
  pattern?: string;
  hard_gate?: boolean;
  tier?: string;
  timeout_seconds?: number;
  execution_scope?: string;
  description?: string;
  gate?: string;
};

type RawDimensionFrontmatter = {
  dimension?: string;
  weight?: number;
  tier?: string;
  metrics?: RawMetricFrontmatter[];
};

type RawManifest = {
  schema?: string;
  evidence_files?: string[];
};

const TIER_ORDER: Record<string, number> = {
  fast: 0,
  normal: 1,
  deep: 2,
};

function isMetricTier(value: string | undefined): value is MetricTier {
  return value === "fast" || value === "normal" || value === "deep";
}

function isExecutionScope(value: string | undefined): value is ExecutionScope {
  return (
    value === "local" || value === "ci" || value === "staging" || value === "prod_observation"
  );
}

/**
 * Extract YAML frontmatter from a markdown file.
 * Frontmatter is delimited by `---` at the start and end.
 */
export function extractFrontmatter(content: string): Record<string, unknown> | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return null;
  }

  const secondFence = trimmed.indexOf("---", 3);
  if (secondFence < 0) {
    return null;
  }

  const yamlBlock = trimmed.slice(3, secondFence).trim();
  if (!yamlBlock) {
    return null;
  }

  try {
    const parsed = yaml.load(yamlBlock);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeMetric(raw: RawMetricFrontmatter): MetricDefinition | null {
  if (!raw.name || !raw.command) {
    return null;
  }

  const tier = isMetricTier(raw.tier) ? raw.tier : "normal";

  return {
    name: raw.name,
    command: raw.command.trim(),
    pattern: raw.pattern?.trim() || undefined,
    hard_gate: raw.hard_gate === true,
    tier,
    timeout_seconds: typeof raw.timeout_seconds === "number" ? raw.timeout_seconds : undefined,
    execution_scope: isExecutionScope(raw.execution_scope) ? raw.execution_scope : undefined,
    description: raw.description,
    gate: raw.gate,
  };
}

/**
 * Load fitness configuration from the manifest and referenced metric docs.
 *
 * @param repoRoot - Root of the repository
 * @returns Parsed fitness configuration with all dimensions and metrics
 */
export function loadFitnessConfig(repoRoot: string): FitnessConfig {
  const manifestPath = path.join(repoRoot, "docs", "fitness", "manifest.yaml");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Fitness manifest not found: ${manifestPath}`);
  }

  const manifestContent = fs.readFileSync(manifestPath, "utf-8");
  const manifest = yaml.load(manifestContent) as RawManifest;
  if (!manifest || !Array.isArray(manifest.evidence_files)) {
    throw new Error("Invalid fitness manifest: missing evidence_files");
  }

  const dimensions: DimensionDefinition[] = [];

  for (const evidenceFile of manifest.evidence_files) {
    const filePath = path.join(repoRoot, evidenceFile);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const frontmatter = extractFrontmatter(content) as RawDimensionFrontmatter | null;
    if (!frontmatter || !frontmatter.dimension) {
      continue;
    }

    const dimensionTier = isMetricTier(frontmatter.tier) ? frontmatter.tier : "normal";
    const rawMetrics = Array.isArray(frontmatter.metrics) ? frontmatter.metrics : [];
    const metrics = rawMetrics
      .map(normalizeMetric)
      .filter((m): m is MetricDefinition => m !== null);

    if (metrics.length === 0) {
      continue;
    }

    dimensions.push({
      name: frontmatter.dimension,
      weight: typeof frontmatter.weight === "number" ? frontmatter.weight : 0,
      tier: dimensionTier,
      metrics,
      sourceFile: evidenceFile,
    });
  }

  return { dimensions };
}

/**
 * Filter metrics by tier: fast includes only fast, normal includes fast+normal,
 * deep includes all. This mirrors the Rust governance filter_metrics behavior.
 */
export function filterByTier(
  metrics: MetricDefinition[],
  requestedTier: MetricTier,
): MetricDefinition[] {
  const maxOrder = TIER_ORDER[requestedTier] ?? 0;
  return metrics.filter((m) => (TIER_ORDER[m.tier] ?? 1) <= maxOrder);
}

/**
 * Filter metrics by execution scope.
 * Metrics without an explicit execution_scope default to "local".
 */
export function filterByScope(
  metrics: MetricDefinition[],
  scope: ExecutionScope,
): MetricDefinition[] {
  return metrics.filter((m) => (m.execution_scope ?? "local") === scope);
}
