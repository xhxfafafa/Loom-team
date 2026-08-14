/**
 * Text report formatting.
 * Ported from Rust report.rs.
 *
 * Generates a human-readable text representation of the fluency report.
 * The framing (fluency vs harnessability) changes several labels.
 */

import { formatPercent, levelChangeLabel } from "./support.js";
import type {
  AutonomyBand,
  HarnessFluencyReport,
} from "./types.js";

export function formatTextReport(report: HarnessFluencyReport): string {
  const isHarnessability = report.framing === "harnessability";
  const reportTitle = isHarnessability
    ? "HARNESSABILITY BASELINE REPORT"
    : "HARNESS FLUENCY REPORT";
  const currentReadinessLabel = isHarnessability
    ? "Current Harnessability Readiness"
    : "Current Level Readiness";
  const nextLevelLabel = isHarnessability
    ? "Next Band Target"
    : "Next Level";
  const nextLevelReadinessLabel = isHarnessability
    ? "Next Band Readiness"
    : "Next Level Readiness";

  const nextLevelReadinessLine =
    report.nextLevelName != null
    && report.nextLevelReadiness == null
    && report.blockingTargetLevel === report.overallLevel
      ? nextLevelReadinessLabel + ": Blocked until " + report.overallLevelName + " is stable"
      : nextLevelReadinessLabel + ": " + formatPercent(report.nextLevelReadiness);

  const blockingHeader = (() => {
    if (report.blockingTargetLevelName == null) return "Blocking Gaps: none";
    if (report.blockingTargetLevel === report.overallLevel) {
      return "Blocking Gaps To Stabilize " + report.blockingTargetLevelName + ":";
    }
    return "Blocking Gaps To " + report.blockingTargetLevelName + ":";
  })();

  const lines: string[] = [
    reportTitle,
    "",
    "Repository: " + report.repoRoot,
    "Profile: " + report.profile,
    "Mode: " + report.mode,
    "Framing: " + report.framing,
    "Model Version: " + report.modelVersion,
    "Overall Level: " + report.overallLevelName,
    currentReadinessLabel + ": " + formatPercent(report.currentLevelReadiness),
    nextLevelLabel + ": " + (report.nextLevelName ?? "Reached top level"),
    nextLevelReadinessLine,
  ];

  if (isHarnessability) {
    lines.push(
      "Baseline Score: " + formatPercent(report.baseline.summary.score),
      "Autonomy Recommendation: "
        + autonomyBandLabel(report.baseline.autonomyRecommendation.band)
        + " — " + report.baseline.autonomyRecommendation.rationale,
    );
  }

  lines.push("", "Dimensions:");

  const dimensions = Object.values(report.dimensions).slice();
  dimensions.sort((a, b) => a.name.localeCompare(b.name));
  for (const dimension of dimensions) {
    lines.push(
      "- " + dimension.name + ": " + dimension.levelName + " (" + formatPercent(dimension.score) + ")",
    );
  }

  const capabilityGroupValues = Object.values(report.capabilityGroups);
  if (capabilityGroupValues.length > 0) {
    lines.push("", "Capability Groups:");
    const sortedGroups = capabilityGroupValues.slice();
    sortedGroups.sort((a, b) => a.name.localeCompare(b.name));
    for (const group of sortedGroups) {
      lines.push(
        "- " + group.name + ": " + formatPercent(group.score)
        + " (" + group.criterionCount + " criteria, " + group.criticalFailures + " critical failures)",
      );
    }
  }

  if (report.evidencePacks.length > 0) {
    lines.push("", "Evidence Packs Prepared:");
    lines.push("- " + report.evidencePacks.length + " packs ready for adjudication");
  }

  lines.push("");
  if (isHarnessability) {
    lines.push("Dominant Gaps:");
    if (report.baseline.dominantGaps.length === 0) {
      lines.push("- None");
    } else {
      for (const gap of report.baseline.dominantGaps) {
        lines.push(
          "- " + gap.capabilityGroupName + ": " + formatPercent(gap.score)
          + " (" + gap.failingCriteria + " failing, " + gap.criticalFailures + " critical)",
        );
      }
    }
  } else {
    lines.push(blockingHeader);
    if (report.blockingTargetLevelName != null) {
      if (report.blockingCriteria.length === 0) {
        lines.push("- None");
      } else {
        for (const criterion of report.blockingCriteria) {
          lines.push("- " + criterion.id + " — " + criterion.evidenceHint);
        }
      }
    }
  }

  lines.push("");
  lines.push(isHarnessability ? "Top Actions (Top 3):" : "Recommended Next Actions:");
  const actions = isHarnessability
    ? report.baseline.topActions
    : report.recommendations;
  if (actions.length === 0) {
    lines.push("- None");
  } else {
    for (const recommendation of actions) {
      lines.push("- " + recommendation.action);
    }
  }

  if (report.comparison != null) {
    lines.push("", "Comparison To Last Snapshot:");
    lines.push(
      "- Overall: " + levelChangeLabel(report.comparison.overallChange)
      + " (" + report.comparison.previousOverallLevel + " -> " + report.overallLevel + ")",
    );
    lines.push(
      "- Dimensions changed: "
      + report.comparison.dimensionChanges.filter((e) => e.change !== "same").length,
    );
    lines.push(
      "- Criteria changed: " + report.comparison.criteriaChanges.length,
    );
  }

  lines.push("", "Snapshot: " + report.snapshotPath);
  return lines.join("\n");
}

function autonomyBandLabel(band: AutonomyBand): string {
  return band;
}
