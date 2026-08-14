/**
 * Harnessability baseline computation.
 * Ported from Rust baseline.rs.
 */

import type {
  AutonomyBand,
  AutonomyRecommendation,
  CapabilityGroupResult,
  CriterionResult,
  DominantGap,
  FluencyLevel,
  HarnessabilityBaseline,
  Recommendation,
} from "./types.js";

const MAX_BASELINE_GAPS = 3;
const MAX_BASELINE_ACTIONS = 3;

export type BaselineInputs = {
  overallLevel: FluencyLevel;
  nextLevel: FluencyLevel | null;
  overallLevelIndex: number;
  totalLevels: number;
  currentLevelReadiness: number;
  blockingCriteria: CriterionResult[];
  capabilityGroups: Record<string, CapabilityGroupResult>;
  recommendations: Recommendation[];
};

export function buildHarnessabilityBaseline(
  inputs: BaselineInputs,
): HarnessabilityBaseline {
  const score = normalizedBaselineScore(
    inputs.overallLevelIndex,
    inputs.totalLevels,
    inputs.currentLevelReadiness,
  );
  const dominantGaps = collectDominantGaps(inputs.capabilityGroups, inputs.blockingCriteria);
  const topActions = inputs.recommendations.slice(0, MAX_BASELINE_ACTIONS);
  const autonomyRecommendation = deriveAutonomyRecommendation(
    score,
    inputs.overallLevelIndex,
    inputs.totalLevels,
    inputs.currentLevelReadiness,
    inputs.blockingCriteria,
  );

  return {
    summary: {
      score,
      overallLevel: inputs.overallLevel.id,
      overallLevelName: inputs.overallLevel.name,
      currentReadiness: inputs.currentLevelReadiness,
      nextLevel: inputs.nextLevel?.id ?? null,
      nextLevelName: inputs.nextLevel?.name ?? null,
    },
    dominantGaps,
    topActions,
    autonomyRecommendation,
  };
}

function normalizedBaselineScore(
  overallLevelIndex: number,
  totalLevels: number,
  currentLevelReadiness: number,
): number {
  const levelCount = Math.max(totalLevels, 1);
  const readiness = Math.max(0, Math.min(1, currentLevelReadiness));
  return (overallLevelIndex + readiness) / levelCount;
}

function collectDominantGaps(
  capabilityGroups: Record<string, CapabilityGroupResult>,
  blockingCriteria: CriterionResult[],
): DominantGap[] {
  const groupValues = Object.values(capabilityGroups);
  if (groupValues.length === 0) {
    return collectDominantGapsFromBlockers(blockingCriteria);
  }

  const groups = groupValues
    .filter((g) => g.failingCriteria > 0 || g.criticalFailures > 0)
    .slice();

  groups.sort((a, b) =>
    b.criticalFailures - a.criticalFailures
    || a.score - b.score
    || b.failingCriteria - a.failingCriteria
    || a.name.localeCompare(b.name),
  );

  return groups.slice(0, MAX_BASELINE_GAPS).map((group) => {
    const rationale = group.criticalFailures > 0
      ? group.criticalFailures + " critical failures across " + group.failingCriteria + " failing criteria"
      : group.failingCriteria + " failing criteria need remediation";
    return {
      capabilityGroup: group.capabilityGroup,
      capabilityGroupName: group.name,
      score: group.score,
      failingCriteria: group.failingCriteria,
      criticalFailures: group.criticalFailures,
      rationale,
    };
  });
}

function collectDominantGapsFromBlockers(
  blockingCriteria: CriterionResult[],
): DominantGap[] {
  const grouped = new Map<string, DominantGap>();

  for (const criterion of blockingCriteria.filter((c) => c.status === "fail")) {
    const groupId = criterion.capabilityGroup ?? criterion.dimension;
    const groupName = criterion.capabilityGroupName ?? groupId;

    let entry = grouped.get(groupId);
    if (!entry) {
      entry = {
        capabilityGroup: groupId,
        capabilityGroupName: groupName,
        score: 0,
        failingCriteria: 0,
        criticalFailures: 0,
        rationale: "",
      };
      grouped.set(groupId, entry);
    }
    entry.failingCriteria++;
    if (criterion.critical) {
      entry.criticalFailures++;
    }
  }

  const gaps = Array.from(grouped.values());
  gaps.sort((a, b) =>
    b.criticalFailures - a.criticalFailures
    || b.failingCriteria - a.failingCriteria
    || a.capabilityGroupName.localeCompare(b.capabilityGroupName),
  );

  return gaps.slice(0, MAX_BASELINE_GAPS).map((gap) => {
    gap.rationale = gap.criticalFailures > 0
      ? gap.criticalFailures + " critical failures across " + gap.failingCriteria + " failing criteria"
      : gap.failingCriteria + " failing criteria need remediation";
    return gap;
  });
}

function deriveAutonomyRecommendation(
  score: number,
  overallLevelIndex: number,
  totalLevels: number,
  currentLevelReadiness: number,
  blockingCriteria: CriterionResult[],
): AutonomyRecommendation {
  const criticalBlockers = blockingCriteria.filter(
    (c) => c.status === "fail" && c.critical,
  ).length;
  const levelRatio = (overallLevelIndex + 1) / Math.max(totalLevels, 1);
  const readiness = Math.max(0, Math.min(1, currentLevelReadiness));

  let band: AutonomyBand;
  if (criticalBlockers > 0) {
    band = "low";
  } else if (levelRatio >= 0.8 && readiness >= 0.85 && score >= 0.8) {
    band = "high";
  } else if (levelRatio >= 0.4 && score >= 0.45) {
    band = "medium";
  } else {
    band = "low";
  }

  let rationale: string;
  if (band === "low" && criticalBlockers > 0) {
    rationale = "Critical blockers remain (" + criticalBlockers
      + "); keep autonomy conservative until they are resolved.";
  } else if (band === "high") {
    rationale = "Baseline score " + Math.round(score * 100)
      + "% with stable readiness supports high autonomy.";
  } else if (band === "medium") {
    rationale = "Baseline score " + Math.round(score * 100)
      + "% indicates partial readiness; keep a human-in-the-loop for riskier changes.";
  } else {
    rationale = "Baseline score " + Math.round(score * 100)
      + "% is below medium confidence; prioritize remediation before autonomous execution.";
  }

  return { band, rationale };
}
