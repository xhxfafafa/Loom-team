/**
 * Evidence pack building.
 * Ported from Rust evidence_pack.rs.
 *
 * Evidence packs are built only for non-deterministic modes. In deterministic
 * mode (the Web UI default), this returns an empty array.
 */

import * as fs from "fs";
import * as path from "path";

import type {
  CriterionResult,
  EvidenceExcerpt,
  EvidencePack,
  FluencyCriterion,
  FluencyMode,
} from "./types";

const MAX_EVIDENCE_FILES = 3;
const MAX_EXCERPT_CHARS = 2000;
const MAX_EXCERPT_LINES = 40;

export function buildEvidencePacks(
  repoRoot: string,
  criteria: FluencyCriterion[],
  results: CriterionResult[],
  mode: FluencyMode,
): EvidencePack[] {
  if (mode === "deterministic") {
    return [];
  }

  const criteriaById = new Map<string, FluencyCriterion>();
  for (const criterion of criteria) {
    criteriaById.set(criterion.id, criterion);
  }

  const packs: EvidencePack[] = [];
  for (const result of results) {
    const criterion = criteriaById.get(result.id);
    if (!criterion) continue;

    const selectionReasons = collectSelectionReasons(criterion, result, mode);
    if (selectionReasons.length === 0) continue;

    packs.push({
      criterionId: result.id,
      capabilityGroup: result.capabilityGroup ?? criterion.capabilityGroup,
      capabilityGroupName: result.capabilityGroupName ?? criterion.capabilityGroup,
      status: result.status,
      evidenceMode: result.evidenceMode,
      detectorType: result.detectorType,
      selectionReasons,
      detail: result.detail,
      evidence: result.evidence,
      excerpts: buildExcerpts(repoRoot, result.evidence),
      whyItMatters: result.whyItMatters,
      recommendedAction: result.recommendedAction,
      evidenceHint: result.evidenceHint,
      aiPromptTemplate: criterion.aiCheck?.promptTemplate ?? null,
      aiRequires: criterion.aiCheck?.requires ?? [],
    });
  }

  packs.sort((a, b) => a.criterionId.localeCompare(b.criterionId));
  return packs;
}

function collectSelectionReasons(
  criterion: FluencyCriterion,
  result: CriterionResult,
  mode: FluencyMode,
): string[] {
  const reasons: string[] = [];

  if (result.status === "fail" && criterion.critical) {
    reasons.push("critical_failure");
  }

  if (result.status === "fail") {
    reasons.push("failed_check");
  }

  if (result.evidenceMode !== "static") {
    reasons.push("non_static_evidence");
  }

  if (criterion.aiCheck != null) {
    reasons.push("ai_check_requested");
  }

  if (mode === "ai" && result.status !== "skipped") {
    reasons.push("ai_mode_selected");
  }

  reasons.sort();
  // Deduplicate
  return Array.from(new Set(reasons));
}

function buildExcerpts(repoRoot: string, evidencePaths: string[]): EvidenceExcerpt[] {
  const excerpts: EvidenceExcerpt[] = [];

  for (const rawPath of evidencePaths.slice(0, MAX_EVIDENCE_FILES)) {
    const resolved = resolveEvidencePath(repoRoot, rawPath);
    if (!resolved) continue;

    try {
      const content = fs.readFileSync(resolved, "utf-8");
      const { text, truncated } = truncateExcerpt(content);
      excerpts.push({
        path: relativeDisplayPath(repoRoot, resolved, rawPath),
        content: text,
        truncated,
      });
    } catch {
      continue;
    }
  }

  return excerpts;
}

function resolveEvidencePath(repoRoot: string, rawPath: string): string | null {
  const canonicalRepoRoot = fs.realpathSync(repoRoot);
  const candidate = path.isAbsolute(rawPath) ? rawPath : path.join(repoRoot, rawPath);

  try {
    const canonical = fs.realpathSync(candidate);
    if (!canonical.startsWith(canonicalRepoRoot)) return null;
    if (!fs.statSync(canonical).isFile()) return null;
    return canonical;
  } catch {
    return null;
  }
}

function truncateExcerpt(content: string): { text: string; truncated: boolean } {
  const lines = content.split("\n");
  let truncated = lines.length > MAX_EXCERPT_LINES;
  let text = lines.slice(0, MAX_EXCERPT_LINES).join("\n");

  if (text.length > MAX_EXCERPT_CHARS) {
    text = text.slice(0, MAX_EXCERPT_CHARS);
    truncated = true;
  }

  if (truncated) {
    text += "\n…"; // ellipsis
  }

  return { text, truncated };
}

function relativeDisplayPath(
  repoRoot: string,
  resolved: string,
  fallback: string,
): string {
  try {
    const canonicalRepoRoot = fs.realpathSync(repoRoot);
    if (resolved.startsWith(canonicalRepoRoot)) {
      return resolved.slice(canonicalRepoRoot.length + 1);
    }
  } catch {
    // fall through
  }
  return fallback;
}
