/**
 * Main fluency analysis engine.
 * Ported from Rust engine.rs.
 *
 * Orchestrates model loading, detector evaluation, scoring, level
 * determination, recommendation generation, baseline computation,
 * snapshot comparison, and report assembly.
 *
 * LIMITATIONS vs Rust engine:
 * - hybrid/ai modes: The Rust engine shells out to the `claude` CLI for
 *   AI-enhanced scoring in hybrid/ai modes. This TS port does NOT invoke
 *   any external LLM. Both hybrid and ai modes degrade to deterministic
 *   execution. Evidence packs ARE still collected for non-deterministic
 *   modes (matching Rust behavior).
 * - codeowners_routing detector: Always fails in the TS port because it
 *   depends on the routa_core Rust library for CODEOWNERS parsing.
 */

import { buildHarnessabilityBaseline, type BaselineInputs } from "./baseline";
import { EvaluationContext, evaluateCriterion } from "./detector";
import { buildEvidencePacks } from "./evidence-pack";
import { loadFluencyModel } from "./model";
import {
  buildComparison,
  canCompareReports,
  loadPreviousSnapshot,
  persistSnapshot,
} from "./snapshot";
import type {
  CapabilityGroupResult,
  CellResult,
  CriterionResult,
  DimensionResult,
  EvaluateOptions,
  FluencyDimension,
  FluencyLevel,
  FluencyModel,
  HarnessFluencyReport,
  Recommendation,
} from "./types";
import { CELL_PASS_THRESHOLD, MAX_RECOMMENDATIONS } from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function evaluateHarnessFluency(options: EvaluateOptions): HarnessFluencyReport {
  const model = loadFluencyModel(options.modelPath);

  const levelOrder = new Map<string, number>();
  model.levels.forEach((level, index) => {
    levelOrder.set(level.id, index);
  });

  const levelById = new Map<string, FluencyLevel>();
  for (const level of model.levels) {
    levelById.set(level.id, level);
  }

  const dimensionById = new Map<string, FluencyDimension>();
  for (const dimension of model.dimensions) {
    dimensionById.set(dimension.id, dimension);
  }

  // Load previous snapshot if compare_last is enabled
  const previousSnapshot = options.compareLast
    ? loadPreviousSnapshot(options.snapshotPath)
    : null;

  // Build evaluation context and run detectors
  const context = new EvaluationContext(options.repoRoot);
  const capabilityGroupNames = buildCapabilityGroupNames(model);

  const criteriaResults: CriterionResult[] = [];
  for (const criterion of model.criteria) {
    // Filter by profile
    if (
      criterion.profiles.length > 0
      && !criterion.profiles.includes(options.profile)
    ) {
      continue;
    }

    const result = evaluateCriterion(criterion, context);
    result.capabilityGroupName = resolveCapabilityGroupName(
      capabilityGroupNames,
      criterion.capabilityGroup,
    );
    criteriaResults.push(result);
  }

  // Build cells (level × dimension matrix)
  const cellAccumulators = new Map<string, CellAccumulator>();
  for (const result of criteriaResults) {
    const level = levelById.get(result.level);
    const dimension = dimensionById.get(result.dimension);
    if (!level || !dimension) {
      throw new Error("unknown level or dimension in criterion " + result.id);
    }

    const cellId = buildCellId(result.level, result.dimension);
    let accumulator = cellAccumulators.get(cellId);
    if (!accumulator) {
      accumulator = {
        id: cellId,
        level: result.level,
        levelName: level.name,
        dimension: result.dimension,
        dimensionName: dimension.name,
        criteria: [],
      };
      cellAccumulators.set(cellId, accumulator);
    }
    accumulator.criteria.push(result);
  }

  // Compute cell scores
  const cells: CellResult[] = [];
  for (const level of model.levels) {
    for (const dimension of model.dimensions) {
      const cellId = buildCellId(level.id, dimension.id);
      const accumulator = cellAccumulators.get(cellId);
      if (!accumulator) {
        throw new Error(
          "missing accumulated cell " + dimension.id + ":" + level.id,
        );
      }

      accumulator.criteria.sort((a, b) => a.id.localeCompare(b.id));

      let applicableWeight = 0;
      let passedWeight = 0;
      for (const criterion of accumulator.criteria) {
        if (criterion.status !== "skipped") {
          applicableWeight += criterion.weight;
        }
        if (criterion.status === "pass") {
          passedWeight += criterion.weight;
        }
      }

      const score = applicableWeight === 0
        ? 0
        : passedWeight / applicableWeight;

      cells.push({
        id: accumulator.id,
        level: accumulator.level,
        levelName: accumulator.levelName,
        dimension: accumulator.dimension,
        dimensionName: accumulator.dimensionName,
        score,
        passed: applicableWeight > 0 && score >= CELL_PASS_THRESHOLD,
        passedWeight,
        applicableWeight,
        criteria: accumulator.criteria,
      });
    }
  }

  const cellById = new Map<string, CellResult>();
  for (const cell of cells) {
    cellById.set(cell.id, cell);
  }

  // Build capability group results
  const capabilityGroups = buildCapabilityGroupResults(criteriaResults, capabilityGroupNames);

  // Build evidence packs
  const evidencePacks = buildEvidencePacks(
    options.repoRoot,
    model.criteria,
    criteriaResults,
    options.mode,
  );

  // Determine dimension levels
  const dimensions: Record<string, DimensionResult> = {};
  for (const dimension of model.dimensions) {
    let achievedIndex = -1;
    for (let i = 0; i < model.levels.length; i++) {
      const level = model.levels[i];
      const cell = cellById.get(buildCellId(level.id, dimension.id));
      if (!cell?.passed) break;
      achievedIndex = i;
    }

    const resolvedIndex = Math.max(achievedIndex, 0);
    const currentLevel = model.levels[resolvedIndex];
    const nextLevel = model.levels[resolvedIndex + 1] ?? null;
    const currentCellId = buildCellId(currentLevel.id, dimension.id);

    dimensions[dimension.id] = {
      dimension: dimension.id,
      name: dimension.name,
      level: currentLevel.id,
      levelName: currentLevel.name,
      levelIndex: resolvedIndex,
      score: cellById.get(currentCellId)?.score ?? 0,
      nextLevel: nextLevel?.id ?? null,
      nextLevelName: nextLevel?.name ?? null,
      nextLevelProgress: nextLevel
        ? (cellById.get(buildCellId(nextLevel.id, dimension.id))?.score ?? null)
        : null,
    };
  }

  // Overall level = minimum across all dimensions
  const overallLevelIndex = Math.min(
    ...Object.values(dimensions).map((d) => d.levelIndex),
  );
  const overallLevel = model.levels[overallLevelIndex];
  const nextLevel = model.levels[overallLevelIndex + 1] ?? null;

  const currentLevelReadiness = averageCellScores(
    model.dimensions, cellById, overallLevel.id,
  );
  const currentLevelDebt = collectFailingCriteriaForLevel(
    model.dimensions, cellById, overallLevel.id,
  );

  const nextLevelReadiness =
    nextLevel && currentLevelDebt.length === 0
      ? averageCellScores(model.dimensions, cellById, nextLevel.id)
      : null;

  const blockingTargetLevel = currentLevelDebt.length > 0
    ? overallLevel
    : nextLevel ?? null;

  let blockingCriteria: CriterionResult[];
  if (blockingTargetLevel == null) {
    blockingCriteria = [];
  } else if (blockingTargetLevel.id === overallLevel.id) {
    blockingCriteria = currentLevelDebt.slice();
  } else {
    blockingCriteria = collectFailingCriteriaForLevel(
      model.dimensions, cellById, blockingTargetLevel.id,
    );
  }
  blockingCriteria.sort((a, b) => a.id.localeCompare(b.id));

  criteriaResults.sort((a, b) => a.id.localeCompare(b.id));
  const recommendations = collectRecommendations(blockingCriteria);

  // Build baseline
  const baseline = buildHarnessabilityBaseline({
    overallLevel,
    nextLevel,
    overallLevelIndex,
    totalLevels: model.levels.length,
    currentLevelReadiness,
    blockingCriteria,
    capabilityGroups,
    recommendations,
  } satisfies BaselineInputs);

  // Assemble report
  const report: HarnessFluencyReport = {
    modelVersion: model.version,
    modelPath: options.modelPath,
    profile: options.profile,
    mode: options.mode,
    framing: options.framing,
    repoRoot: options.repoRoot,
    generatedAt: new Date().toISOString(),
    snapshotPath: options.snapshotPath,
    overallLevel: overallLevel.id,
    overallLevelName: overallLevel.name,
    currentLevelReadiness,
    nextLevel: nextLevel?.id ?? null,
    nextLevelName: nextLevel?.name ?? null,
    nextLevelReadiness,
    blockingTargetLevel: blockingTargetLevel?.id ?? null,
    blockingTargetLevelName: blockingTargetLevel?.name ?? null,
    dimensions,
    capabilityGroups,
    evidencePacks,
    cells,
    criteria: criteriaResults,
    blockingCriteria: blockingCriteria.slice(),
    recommendations,
    baseline,
    comparison: null,
  };

  // Compare with previous snapshot
  if (previousSnapshot && canCompareReports(previousSnapshot, report)) {
    report.comparison = buildComparison(previousSnapshot, report, levelOrder);
  }

  // Persist snapshot
  if (options.save) {
    persistSnapshot(report, options.snapshotPath);
  }

  return report;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CellAccumulator = {
  id: string;
  level: string;
  levelName: string;
  dimension: string;
  dimensionName: string;
  criteria: CriterionResult[];
};

function buildCellId(level: string, dimension: string): string {
  return dimension + ":" + level;
}

function buildCapabilityGroupNames(
  model: FluencyModel,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const group of model.capabilityGroups) {
    names.set(group.id, group.name);
  }
  for (const dimension of model.dimensions) {
    if (!names.has(dimension.id)) {
      names.set(dimension.id, dimension.name);
    }
  }
  return names;
}

function resolveCapabilityGroupName(
  names: Map<string, string>,
  capabilityGroup: string,
): string {
  return names.get(capabilityGroup) ?? capabilityGroup;
}

function buildCapabilityGroupResults(
  criteriaResults: CriterionResult[],
  capabilityGroupNames: Map<string, string>,
): Record<string, CapabilityGroupResult> {
  type Accumulator = {
    id: string;
    name: string;
    criterionCount: number;
    passingCriteria: number;
    failingCriteria: number;
    criticalFailures: number;
    applicableWeight: number;
    passedWeight: number;
    evidenceModes: Record<string, number>;
  };

  const accumulators = new Map<string, Accumulator>();

  for (const criterion of criteriaResults) {
    if (criterion.capabilityGroup == null) continue;

    const groupId = criterion.capabilityGroup;
    const evidenceMode = criterion.evidenceMode;

    let accumulator = accumulators.get(groupId);
    if (!accumulator) {
      accumulator = {
        id: groupId,
        name: resolveCapabilityGroupName(capabilityGroupNames, groupId),
        criterionCount: 0,
        passingCriteria: 0,
        failingCriteria: 0,
        criticalFailures: 0,
        applicableWeight: 0,
        passedWeight: 0,
        evidenceModes: {},
      };
      accumulators.set(groupId, accumulator);
    }

    accumulator.criterionCount++;
    accumulator.evidenceModes[evidenceMode] =
      (accumulator.evidenceModes[evidenceMode] ?? 0) + 1;

    switch (criterion.status) {
      case "pass":
        accumulator.passingCriteria++;
        accumulator.applicableWeight += criterion.weight;
        accumulator.passedWeight += criterion.weight;
        break;
      case "fail":
        accumulator.failingCriteria++;
        accumulator.applicableWeight += criterion.weight;
        if (criterion.critical) {
          accumulator.criticalFailures++;
        }
        break;
      case "skipped":
        // No weight contribution
        break;
    }
  }

  const result: Record<string, CapabilityGroupResult> = {};
  for (const [groupId, acc] of Array.from(accumulators.entries())) {
    const score = acc.applicableWeight === 0
      ? 0
      : acc.passedWeight / acc.applicableWeight;
    result[groupId] = {
      capabilityGroup: acc.id,
      name: acc.name,
      score,
      criterionCount: acc.criterionCount,
      passingCriteria: acc.passingCriteria,
      failingCriteria: acc.failingCriteria,
      criticalFailures: acc.criticalFailures,
      applicableWeight: acc.applicableWeight,
      passedWeight: acc.passedWeight,
      evidenceModes: acc.evidenceModes,
    };
  }

  return result;
}

function deterministicPriority(detectorType: string): number {
  return detectorType === "manual_attestation" ? 1 : 0;
}

function collectRecommendations(criteria: CriterionResult[]): Recommendation[] {
  const deduped = new Set<string>();
  const sorted = criteria
    .filter((c) => c.status === "fail")
    .slice();

  sorted.sort((a, b) => {
    // Critical first, then higher weight, then non-manual before manual, then by id
    if (a.critical !== b.critical) return a.critical ? -1 : 1;
    if (a.weight !== b.weight) return b.weight - a.weight;
    const pa = deterministicPriority(a.detectorType);
    const pb = deterministicPriority(b.detectorType);
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  });

  const recommendations: Recommendation[] = [];
  for (const criterion of sorted) {
    if (deduped.has(criterion.recommendedAction)) continue;
    deduped.add(criterion.recommendedAction);

    recommendations.push({
      criterionId: criterion.id,
      action: criterion.recommendedAction,
      whyItMatters: criterion.whyItMatters,
      evidenceHint: criterion.evidenceHint,
      critical: criterion.critical,
      weight: criterion.weight,
    });

    if (recommendations.length >= MAX_RECOMMENDATIONS) break;
  }

  return recommendations;
}

function averageCellScores(
  dimensions: FluencyDimension[],
  cellById: Map<string, CellResult>,
  levelId: string,
): number {
  let total = 0;
  for (const dimension of dimensions) {
    const cell = cellById.get(buildCellId(levelId, dimension.id));
    total += cell?.score ?? 0;
  }
  return total / dimensions.length;
}

function collectFailingCriteriaForLevel(
  dimensions: FluencyDimension[],
  cellById: Map<string, CellResult>,
  levelId: string,
): CriterionResult[] {
  const failing: CriterionResult[] = [];
  for (const dimension of dimensions) {
    const cell = cellById.get(buildCellId(levelId, dimension.id));
    if (cell && !cell.passed) {
      for (const criterion of cell.criteria) {
        if (criterion.status === "fail") {
          failing.push(criterion);
        }
      }
    }
  }
  return failing;
}
