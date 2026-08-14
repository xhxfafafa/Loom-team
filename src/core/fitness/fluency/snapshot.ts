/**
 * Snapshot save/load and comparison.
 * Ported from Rust snapshot.rs.
 *
 * Snapshots are persisted as pretty-printed JSON to the configured
 * snapshot path. Comparison computes per-dimension level changes and
 * per-criterion status changes between the previous and current reports.
 */

import * as fs from "fs";
import * as path from "path";

import type {
  CriterionChange,
  CriterionStatus,
  DimensionChange,
  HarnessFluencyReport,
  LevelChange,
  ReportComparison,
} from "./types.js";

/**
 * Load a previous snapshot from disk. Returns null if the file doesn't exist.
 */
export function loadPreviousSnapshot(
  snapshotPath: string,
): HarnessFluencyReport | null {
  if (!fs.existsSync(snapshotPath)) {
    return null;
  }

  const content = fs.readFileSync(snapshotPath, "utf-8");
  return JSON.parse(content) as HarnessFluencyReport;
}

/**
 * Persist the current report as a snapshot.
 */
export function persistSnapshot(
  report: HarnessFluencyReport,
  snapshotPath: string,
): void {
  const parent = path.dirname(snapshotPath);
  fs.mkdirSync(parent, { recursive: true });
  const json = JSON.stringify(report, null, 2);
  fs.writeFileSync(snapshotPath, json + "\n", "utf-8");
}

/**
 * Check whether two reports can be compared (same model version and profile).
 */
export function canCompareReports(
  previous: HarnessFluencyReport,
  current: HarnessFluencyReport,
): boolean {
  return previous.modelVersion === current.modelVersion
    && previous.profile === current.profile;
}

/**
 * Build a comparison between a previous and current report.
 */
export function buildComparison(
  previousReport: HarnessFluencyReport,
  currentReport: HarnessFluencyReport,
  levelOrder: Map<string, number>,
): ReportComparison {
  const dimensionChanges: DimensionChange[] = [];
  const dimensionValues = Object.values(currentReport.dimensions);

  for (const dimension of dimensionValues) {
    const previousDimension = previousReport.dimensions[dimension.dimension] ?? null;
    dimensionChanges.push({
      dimension: dimension.dimension,
      previousLevel: previousDimension?.level ?? "unknown",
      currentLevel: dimension.level,
      change: previousDimension
        ? compareLevelIds(previousDimension.level, dimension.level, levelOrder)
        : "up",
    });
  }
  dimensionChanges.sort((a, b) => a.dimension.localeCompare(b.dimension));

  const previousCriteria = new Map<string, CriterionStatus>();
  for (const criterion of previousReport.criteria) {
    previousCriteria.set(criterion.id, criterion.status);
  }
  const currentCriteria = new Map<string, CriterionStatus>();
  for (const criterion of currentReport.criteria) {
    currentCriteria.set(criterion.id, criterion.status);
  }

  const allIds = new Set<string>([
    ...Array.from(previousCriteria.keys()),
    ...Array.from(currentCriteria.keys()),
  ]);
  const sortedIds = Array.from(allIds).sort();

  const criteriaChanges: CriterionChange[] = [];
  for (const id of sortedIds) {
    const previousStatus = previousCriteria.get(id) ?? null;
    const currentStatus = currentCriteria.get(id) ?? null;
    if (previousStatus !== currentStatus) {
      criteriaChanges.push({
        id,
        previousStatus,
        currentStatus,
      });
    }
  }

  return {
    previousGeneratedAt: previousReport.generatedAt,
    previousOverallLevel: previousReport.overallLevel,
    overallChange: compareLevelIds(
      previousReport.overallLevel,
      currentReport.overallLevel,
      levelOrder,
    ),
    dimensionChanges,
    criteriaChanges,
  };
}

function compareLevelIds(
  previousLevel: string,
  currentLevel: string,
  order: Map<string, number>,
): LevelChange {
  const previousIndex = order.get(previousLevel) ?? Number.MAX_SAFE_INTEGER;
  const currentIndex = order.get(currentLevel) ?? Number.MAX_SAFE_INTEGER;
  if (previousIndex === currentIndex) return "same";
  if (currentIndex > previousIndex) return "up";
  return "down";
}
