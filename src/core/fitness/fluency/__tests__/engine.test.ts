/**
 * Unit tests for the harness fluency engine.
 * Mirrors key Rust tests.rs scenarios using temp-dir fixtures.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { loadFluencyModel } from "../model";
import { evaluateHarnessFluency } from "../engine";
import { EvaluationContext, evaluateCriterion } from "../detector";
import { buildComparison, canCompareReports, loadPreviousSnapshot, persistSnapshot } from "../snapshot";
import { formatTextReport } from "../report";
import { buildRegex, formatPercent } from "../support";
import type {
  CriterionResult,
  EvaluateOptions,
  FluencyCriterion,
  HarnessFluencyReport,
} from "../types";

// ---------------------------------------------------------------------------
// Temp directory helper
// ---------------------------------------------------------------------------

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fluency-test-"));
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function writeJson(filePath: string, value: unknown): void {
  writeFile(filePath, JSON.stringify(value, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Model loading tests
// ---------------------------------------------------------------------------

describe("loadFluencyModel", () => {
  it("loads a minimal valid model", () => {
    const dir = createTempDir();
    const modelPath = path.join(dir, "model.yaml");
    writeFile(modelPath, `
version: 1
levels:
  - id: awareness
    name: Awareness
  - id: assisted
    name: Assisted
dimensions:
  - id: collaboration
    name: Collaboration
criteria:
  - id: coll.awareness.file
    level: awareness
    dimension: collaboration
    weight: 1
    critical: true
    why_it_matters: test
    recommended_action: test
    evidence_hint: AGENTS.md
    detector:
      type: file_exists
      path: AGENTS.md
  - id: coll.awareness.readme
    level: awareness
    dimension: collaboration
    weight: 1
    critical: false
    why_it_matters: test
    recommended_action: test
    evidence_hint: README.md
    detector:
      type: file_exists
      path: README.md
  - id: coll.assisted.file
    level: assisted
    dimension: collaboration
    weight: 1
    critical: true
    why_it_matters: test
    recommended_action: test
    evidence_hint: file
    detector:
      type: file_exists
      path: file.txt
  - id: coll.assisted.readme
    level: assisted
    dimension: collaboration
    weight: 1
    critical: false
    why_it_matters: test
    recommended_action: test
    evidence_hint: readme
    detector:
      type: file_exists
      path: README2.md
`);

    const model = loadFluencyModel(modelPath);
    expect(model.version).toBe(1);
    expect(model.levels).toHaveLength(2);
    expect(model.dimensions).toHaveLength(1);
    expect(model.criteria).toHaveLength(4);
    expect(model.levels[0].id).toBe("awareness");
    expect(model.criteria[0].detector.type).toBe("file_exists");

    fs.rmSync(dir, { recursive: true });
  });

  it("rejects duplicate level ids", () => {
    const dir = createTempDir();
    const modelPath = path.join(dir, "model.yaml");
    writeFile(modelPath, `
version: 1
levels:
  - id: awareness
    name: Awareness
  - id: awareness
    name: Awareness Duplicate
dimensions:
  - id: collaboration
    name: Collaboration
criteria:
  - id: coll.awareness.a
    level: awareness
    dimension: collaboration
    weight: 1
    critical: true
    why_it_matters: a
    recommended_action: a
    evidence_hint: a
    detector:
      type: file_exists
      path: a.txt
  - id: coll.awareness.b
    level: awareness
    dimension: collaboration
    weight: 1
    critical: false
    why_it_matters: b
    recommended_action: b
    evidence_hint: b
    detector:
      type: file_exists
      path: b.txt
`);

    expect(() => loadFluencyModel(modelPath)).toThrow("duplicate ids");
    fs.rmSync(dir, { recursive: true });
  });

  it("rejects fewer than 2 criteria per cell", () => {
    const dir = createTempDir();
    const modelPath = path.join(dir, "model.yaml");
    writeFile(modelPath, `
version: 1
levels:
  - id: awareness
    name: Awareness
dimensions:
  - id: collaboration
    name: Collaboration
criteria:
  - id: coll.awareness.only
    level: awareness
    dimension: collaboration
    weight: 1
    critical: true
    why_it_matters: test
    recommended_action: test
    evidence_hint: test
    detector:
      type: file_exists
      path: file.txt
`);

    expect(() => loadFluencyModel(modelPath)).toThrow("at least 2 criteria");
    fs.rmSync(dir, { recursive: true });
  });

  it("rejects unknown level references", () => {
    const dir = createTempDir();
    const modelPath = path.join(dir, "model.yaml");
    writeFile(modelPath, `
version: 1
levels:
  - id: awareness
    name: Awareness
  - id: assisted
    name: Assisted
dimensions:
  - id: collaboration
    name: Collaboration
criteria:
  - id: coll.unknown.a
    level: unknown_level
    dimension: collaboration
    weight: 1
    critical: true
    why_it_matters: test
    recommended_action: test
    evidence_hint: test
    detector:
      type: file_exists
      path: a.txt
  - id: coll.unknown.b
    level: awareness
    dimension: collaboration
    weight: 1
    critical: false
    why_it_matters: test
    recommended_action: test
    evidence_hint: test
    detector:
      type: file_exists
      path: b.txt
`);

    expect(() => loadFluencyModel(modelPath)).toThrow("unknown level");
    fs.rmSync(dir, { recursive: true });
  });

  it("rejects cyclic extends", () => {
    const dir = createTempDir();
    const firstModel = path.join(dir, "first.yaml");
    const secondModel = path.join(dir, "second.yaml");
    writeFile(firstModel, "extends: ./second.yaml\n");
    writeFile(secondModel, "extends: ./first.yaml\n");

    expect(() => loadFluencyModel(firstModel)).toThrow("cyclic");
    fs.rmSync(dir, { recursive: true });
  });

  it("supports extends with criteria concatenation", () => {
    const dir = createTempDir();
    const basePath = path.join(dir, "base.yaml");
    const overlayPath = path.join(dir, "overlay.yaml");

    writeFile(basePath, `
version: 1
levels:
  - id: awareness
    name: Awareness
  - id: assisted
    name: Assisted
dimensions:
  - id: collaboration
    name: Collaboration
criteria:
  - id: coll.awareness.base_a
    level: awareness
    dimension: collaboration
    weight: 1
    critical: true
    why_it_matters: test
    recommended_action: test
    evidence_hint: test
    detector:
      type: file_exists
      path: base_a.txt
  - id: coll.awareness.base_b
    level: awareness
    dimension: collaboration
    weight: 1
    critical: false
    why_it_matters: test
    recommended_action: test
    evidence_hint: test
    detector:
      type: file_exists
      path: base_b.txt
  - id: coll.assisted.base_c
    level: assisted
    dimension: collaboration
    weight: 1
    critical: true
    why_it_matters: test
    recommended_action: test
    evidence_hint: test
    detector:
      type: file_exists
      path: base_c.txt
  - id: coll.assisted.base_d
    level: assisted
    dimension: collaboration
    weight: 1
    critical: false
    why_it_matters: test
    recommended_action: test
    evidence_hint: test
    detector:
      type: file_exists
      path: base_d.txt
`);

    writeFile(overlayPath, `
extends: ./base.yaml
criteria:
  - id: coll.awareness.overlay_a
    level: awareness
    dimension: collaboration
    weight: 2
    critical: true
    why_it_matters: overlay
    recommended_action: overlay
    evidence_hint: overlay
    detector:
      type: file_exists
      path: overlay.txt
  - id: coll.assisted.overlay_b
    level: assisted
    dimension: collaboration
    weight: 2
    critical: true
    why_it_matters: overlay
    recommended_action: overlay
    evidence_hint: overlay
    detector:
      type: file_exists
      path: overlay2.txt
`);

    const model = loadFluencyModel(overlayPath);
    expect(model.criteria).toHaveLength(6); // 4 base + 2 overlay
    expect(model.criteria.some((c) => c.id === "coll.awareness.overlay_a")).toBe(true);
    expect(model.criteria.some((c) => c.id === "coll.awareness.base_a")).toBe(true);

    fs.rmSync(dir, { recursive: true });
  });

  it("loads the real generic model from the repo", () => {
    const repoRoot = path.resolve(__dirname, "../../../../../..");
    const modelPath = path.join(repoRoot, "docs/fitness/harness-fluency.model.yaml");

    if (!fs.existsSync(modelPath)) return; // Skip if not in repo

    const model = loadFluencyModel(modelPath);
    expect(model.levels).toHaveLength(5);
    expect(model.dimensions).toHaveLength(5);
    expect(model.criteria).toHaveLength(50);
  });

  it("loads the agent_orchestrator profile overlay", () => {
    const repoRoot = path.resolve(__dirname, "../../../../../..");
    const overlayPath = path.join(
      repoRoot,
      "docs/fitness/harness-fluency.profile.agent_orchestrator.yaml",
    );

    if (!fs.existsSync(overlayPath)) return;

    const model = loadFluencyModel(overlayPath);
    expect(model.criteria.length).toBeGreaterThan(50);
    expect(model.criteria.some((c) => c.id === "harness.awareness.acp_runtime_surface")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Detector tests
// ---------------------------------------------------------------------------

describe("detectors", () => {
  let dir: string;
  let context: EvaluationContext;

  beforeEach(() => {
    dir = createTempDir();
    context = new EvaluationContext(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true });
  });

  function makeCriterion(detector: FluencyCriterion["detector"]): FluencyCriterion {
    return {
      id: "test",
      level: "awareness",
      dimension: "collaboration",
      capabilityGroup: "collaboration",
      weight: 1,
      critical: false,
      profiles: [],
      evidenceMode: "static",
      whyItMatters: "test",
      recommendedAction: "test",
      evidenceHint: "test",
      aiCheck: null,
      detector,
    };
  }

  it("file_exists passes when file exists", () => {
    writeFile(path.join(dir, "AGENTS.md"), "# Agents");
    const result = evaluateCriterion(makeCriterion({ type: "file_exists", path: "AGENTS.md" }), context);
    expect(result.status).toBe("pass");
  });

  it("file_exists fails when file missing", () => {
    const result = evaluateCriterion(makeCriterion({ type: "file_exists", path: "MISSING.md" }), context);
    expect(result.status).toBe("fail");
  });

  it("any_file_exists passes when at least one file exists", () => {
    writeFile(path.join(dir, "CLAUDE.md"), "# Claude");
    const result = evaluateCriterion(
      makeCriterion({ type: "any_file_exists", paths: ["AGENTS.md", "CLAUDE.md"] }),
      context,
    );
    expect(result.status).toBe("pass");
  });

  it("any_file_exists fails when no files exist", () => {
    const result = evaluateCriterion(
      makeCriterion({ type: "any_file_exists", paths: ["MISSING1.md", "MISSING2.md"] }),
      context,
    );
    expect(result.status).toBe("fail");
  });

  it("all_of passes when all sub-detectors pass", () => {
    writeFile(path.join(dir, "a.txt"), "a");
    writeFile(path.join(dir, "b.txt"), "b");
    const result = evaluateCriterion(
      makeCriterion({
        type: "all_of",
        detectors: [
          { type: "file_exists", path: "a.txt" },
          { type: "file_exists", path: "b.txt" },
        ],
      }),
      context,
    );
    expect(result.status).toBe("pass");
  });

  it("all_of fails when any sub-detector fails", () => {
    writeFile(path.join(dir, "a.txt"), "a");
    const result = evaluateCriterion(
      makeCriterion({
        type: "all_of",
        detectors: [
          { type: "file_exists", path: "a.txt" },
          { type: "file_exists", path: "missing.txt" },
        ],
      }),
      context,
    );
    expect(result.status).toBe("fail");
  });

  it("any_of passes when at least one sub-detector passes", () => {
    writeFile(path.join(dir, "b.txt"), "b");
    const result = evaluateCriterion(
      makeCriterion({
        type: "any_of",
        detectors: [
          { type: "file_exists", path: "missing.txt" },
          { type: "file_exists", path: "b.txt" },
        ],
      }),
      context,
    );
    expect(result.status).toBe("pass");
  });

  it("glob_count passes when enough files match", () => {
    writeFile(path.join(dir, "docs/issues/one.md"), "# one");
    writeFile(path.join(dir, "docs/issues/two.md"), "# two");
    writeFile(path.join(dir, "docs/issues/three.md"), "# three");
    const result = evaluateCriterion(
      makeCriterion({ type: "glob_count", patterns: ["docs/issues/*.md"], min: 2 }),
      context,
    );
    expect(result.status).toBe("pass");
  });

  it("glob_count fails when too few files match", () => {
    writeFile(path.join(dir, "docs/issues/one.md"), "# one");
    const result = evaluateCriterion(
      makeCriterion({ type: "glob_count", patterns: ["docs/issues/*.md"], min: 5 }),
      context,
    );
    expect(result.status).toBe("fail");
  });

  it("file_contains_regex passes on match", () => {
    writeFile(path.join(dir, "test.txt"), "hello world agent instructions");
    const result = evaluateCriterion(
      makeCriterion({
        type: "file_contains_regex",
        path: "test.txt",
        pattern: "\\b(agent|assistant)\\b",
        flags: "i",
      }),
      context,
    );
    expect(result.status).toBe("pass");
  });

  it("file_contains_regex fails on no match", () => {
    writeFile(path.join(dir, "test.txt"), "nothing relevant here");
    const result = evaluateCriterion(
      makeCriterion({
        type: "file_contains_regex",
        path: "test.txt",
        pattern: "\\b(agent|assistant)\\b",
        flags: "i",
      }),
      context,
    );
    expect(result.status).toBe("fail");
  });

  it("json_path_exists passes when path found", () => {
    writeJson(path.join(dir, "package.json"), {
      scripts: { test: "vitest", build: "tsc" },
    });
    const result = evaluateCriterion(
      makeCriterion({
        type: "json_path_exists",
        path: "package.json",
        jsonPath: [{ kind: "key", value: "scripts" }, { kind: "key", value: "test" }],
      }),
      context,
    );
    expect(result.status).toBe("pass");
  });

  it("json_path_exists fails when path missing", () => {
    writeJson(path.join(dir, "package.json"), { name: "test" });
    const result = evaluateCriterion(
      makeCriterion({
        type: "json_path_exists",
        path: "package.json",
        jsonPath: [{ kind: "key", value: "scripts" }],
      }),
      context,
    );
    expect(result.status).toBe("fail");
  });

  it("yaml_path_exists passes when path found", () => {
    writeFile(path.join(dir, "config.yaml"), "jobs:\n  build:\n    steps:\n      - run: echo hi\n");
    const result = evaluateCriterion(
      makeCriterion({
        type: "yaml_path_exists",
        path: "config.yaml",
        yamlPath: [{ kind: "key", value: "jobs" }, { kind: "key", value: "build" }],
      }),
      context,
    );
    expect(result.status).toBe("pass");
  });

  it("manual_attestation returns skipped", () => {
    const result = evaluateCriterion(
      makeCriterion({ type: "manual_attestation", prompt: "Do you have X?" }),
      context,
    );
    expect(result.status).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// Engine integration test
// ---------------------------------------------------------------------------

describe("evaluateHarnessFluency", () => {
  it("produces a complete report from a temp repo", () => {
    const dir = createTempDir();
    writeFile(path.join(dir, "AGENTS.md"), "# Agents");
    writeFile(path.join(dir, "README.md"), "# Readme");

    const modelPath = path.join(dir, "docs/fitness/model.yaml");
    const snapshotPath = path.join(dir, "docs/fitness/latest.json");

    writeFile(modelPath, `
version: 1
levels:
  - id: awareness
    name: Awareness
  - id: assisted
    name: Assisted
dimensions:
  - id: collaboration
    name: Collaboration
criteria:
  - id: coll.awareness.agents
    level: awareness
    dimension: collaboration
    weight: 2
    critical: true
    why_it_matters: test
    recommended_action: add agents
    evidence_hint: AGENTS.md
    detector:
      type: any_file_exists
      paths:
        - AGENTS.md
        - CLAUDE.md
  - id: coll.awareness.readme
    level: awareness
    dimension: collaboration
    weight: 1
    critical: false
    why_it_matters: test
    recommended_action: add readme
    evidence_hint: README.md
    detector:
      type: file_exists
      path: README.md
  - id: coll.assisted.template
    level: assisted
    dimension: collaboration
    weight: 2
    critical: true
    why_it_matters: test
    recommended_action: add template
    evidence_hint: template.md
    detector:
      type: file_exists
      path: template.md
  - id: coll.assisted.scripts
    level: assisted
    dimension: collaboration
    weight: 1
    critical: false
    why_it_matters: test
    recommended_action: add scripts
    evidence_hint: package.json
    detector:
      type: file_exists
      path: package.json
`);

    const report = evaluateHarnessFluency({
      repoRoot: dir,
      modelPath,
      profile: "generic",
      mode: "deterministic",
      framing: "fluency",
      snapshotPath,
      compareLast: false,
      save: false,
    });

    expect(report.modelVersion).toBe(1);
    expect(report.profile).toBe("generic");
    expect(report.overallLevel).toBe("awareness");
    expect(report.criteria).toHaveLength(4);
    expect(report.cells).toHaveLength(2); // 1 dim × 2 levels

    // Awareness cell should pass (AGENTS.md + README.md exist)
    const awarenessCell = report.cells.find((c) => c.level === "awareness");
    expect(awarenessCell?.passed).toBe(true);

    // Assisted cell should fail (template.md and package.json don't exist)
    const assistedCell = report.cells.find((c) => c.level === "assisted");
    expect(assistedCell?.passed).toBe(false);

    // Blocking criteria should include the failing assisted criteria
    expect(report.blockingCriteria.length).toBeGreaterThan(0);

    // Recommendations should be generated
    expect(report.recommendations.length).toBeGreaterThan(0);

    fs.rmSync(dir, { recursive: true });
  });

  it("saves snapshot and compares with previous", () => {
    const dir = createTempDir();
    writeFile(path.join(dir, "AGENTS.md"), "# Agents");
    writeFile(path.join(dir, "README.md"), "# Readme");

    const modelPath = path.join(dir, "docs/fitness/model.yaml");
    const snapshotPath = path.join(dir, "docs/fitness/latest.json");

    writeFile(modelPath, `
version: 1
levels:
  - id: awareness
    name: Awareness
  - id: assisted
    name: Assisted
dimensions:
  - id: collaboration
    name: Collaboration
criteria:
  - id: coll.awareness.a
    level: awareness
    dimension: collaboration
    weight: 1
    critical: true
    why_it_matters: a
    recommended_action: a
    evidence_hint: a
    detector:
      type: file_exists
      path: AGENTS.md
  - id: coll.awareness.b
    level: awareness
    dimension: collaboration
    weight: 1
    critical: false
    why_it_matters: b
    recommended_action: b
    evidence_hint: b
    detector:
      type: file_exists
      path: README.md
  - id: coll.assisted.c
    level: assisted
    dimension: collaboration
    weight: 1
    critical: true
    why_it_matters: c
    recommended_action: c
    evidence_hint: c
    detector:
      type: file_exists
      path: AGENTS.md
  - id: coll.assisted.d
    level: assisted
    dimension: collaboration
    weight: 1
    critical: false
    why_it_matters: d
    recommended_action: d
    evidence_hint: d
    detector:
      type: file_exists
      path: README.md
`);

    // First run — save snapshot
    const report1 = evaluateHarnessFluency({
      repoRoot: dir,
      modelPath,
      profile: "generic",
      mode: "deterministic",
      framing: "fluency",
      snapshotPath,
      compareLast: false,
      save: true,
    });
    expect(report1.comparison).toBeNull();
    expect(fs.existsSync(snapshotPath)).toBe(true);

    // Second run — compare with previous
    const report2 = evaluateHarnessFluency({
      repoRoot: dir,
      modelPath,
      profile: "generic",
      mode: "deterministic",
      framing: "fluency",
      snapshotPath,
      compareLast: true,
      save: true,
    });
    expect(report2.comparison).not.toBeNull();
    expect(report2.comparison?.overallChange).toBe("same");
    expect(report2.comparison?.criteriaChanges).toHaveLength(0);

    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Snapshot tests
// ---------------------------------------------------------------------------

describe("snapshot", () => {
  it("persistSnapshot writes valid JSON", () => {
    const dir = createTempDir();
    const snapshotPath = path.join(dir, "snapshot.json");

    const report = {
      modelVersion: 1,
      modelPath: "test",
      profile: "generic",
      mode: "deterministic" as const,
      framing: "fluency" as const,
      repoRoot: dir,
      generatedAt: "2026-01-01T00:00:00.000Z",
      snapshotPath,
      overallLevel: "awareness",
      overallLevelName: "Awareness",
      currentLevelReadiness: 0.8,
      nextLevel: null,
      nextLevelName: null,
      nextLevelReadiness: null,
      blockingTargetLevel: null,
      blockingTargetLevelName: null,
      dimensions: {},
      capabilityGroups: {},
      evidencePacks: [],
      cells: [],
      criteria: [],
      blockingCriteria: [],
      recommendations: [],
      baseline: {
        summary: {
          score: 0.2,
          overallLevel: "awareness",
          overallLevelName: "Awareness",
          currentReadiness: 0.8,
          nextLevel: null,
          nextLevelName: null,
        },
        dominantGaps: [],
        topActions: [],
        autonomyRecommendation: { band: "low" as const, rationale: "test" },
      },
      comparison: null,
    };

    persistSnapshot(report, snapshotPath);
    expect(fs.existsSync(snapshotPath)).toBe(true);

    const loaded = loadPreviousSnapshot(snapshotPath);
    expect(loaded).not.toBeNull();
    expect(loaded?.overallLevel).toBe("awareness");

    fs.rmSync(dir, { recursive: true });
  });

  it("loadPreviousSnapshot returns null for missing file", () => {
    expect(loadPreviousSnapshot("/nonexistent/path.json")).toBeNull();
  });

  it("canCompareReports rejects mismatched versions", () => {
    const a = { modelVersion: 1, profile: "generic" } as HarnessFluencyReport;
    const b = { modelVersion: 2, profile: "generic" } as HarnessFluencyReport;
    expect(canCompareReports(a, b)).toBe(false);
  });

  it("canCompareReports rejects mismatched profiles", () => {
    const a = { modelVersion: 1, profile: "generic" } as HarnessFluencyReport;
    const b = { modelVersion: 1, profile: "agent_orchestrator" } as HarnessFluencyReport;
    expect(canCompareReports(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Support function tests
// ---------------------------------------------------------------------------

describe("support", () => {
  it("buildRegex creates valid regex with flags", () => {
    const regex = buildRegex("\\bagent\\b", "i", "test");
    expect(regex.test("Agent workflow")).toBe(true);
  });

  it("buildRegex rejects patterns over max length", () => {
    const longPattern = "a".repeat(300);
    expect(() => buildRegex(longPattern, "", "test")).toThrow("exceeds max length");
  });

  it("buildRegex rejects unsupported flags", () => {
    expect(() => buildRegex("test", "Z", "test")).toThrow("unsupported flag");
  });

  it("formatPercent formats correctly", () => {
    expect(formatPercent(0.85)).toBe("85%");
    expect(formatPercent(1.0)).toBe("100%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(null)).toBe("n/a");
    expect(formatPercent(undefined)).toBe("n/a");
  });
});

// ---------------------------------------------------------------------------
// Text report format test
// ---------------------------------------------------------------------------

describe("formatTextReport", () => {
  it("produces non-empty text output", () => {
    const dir = createTempDir();
    writeFile(path.join(dir, "AGENTS.md"), "# Agents");
    writeFile(path.join(dir, "README.md"), "# Readme");

    const modelPath = path.join(dir, "docs/fitness/model.yaml");
    writeFile(modelPath, `
version: 1
levels:
  - id: awareness
    name: Awareness
  - id: assisted
    name: Assisted
dimensions:
  - id: collaboration
    name: Collaboration
criteria:
  - id: coll.awareness.a
    level: awareness
    dimension: collaboration
    weight: 1
    critical: true
    why_it_matters: a
    recommended_action: a
    evidence_hint: a
    detector:
      type: file_exists
      path: AGENTS.md
  - id: coll.awareness.b
    level: awareness
    dimension: collaboration
    weight: 1
    critical: false
    why_it_matters: b
    recommended_action: b
    evidence_hint: b
    detector:
      type: file_exists
      path: README.md
  - id: coll.assisted.c
    level: assisted
    dimension: collaboration
    weight: 1
    critical: true
    why_it_matters: c
    recommended_action: c
    evidence_hint: c
    detector:
      type: file_exists
      path: missing.txt
  - id: coll.assisted.d
    level: assisted
    dimension: collaboration
    weight: 1
    critical: false
    why_it_matters: d
    recommended_action: d
    evidence_hint: d
    detector:
      type: file_exists
      path: missing2.txt
`);

    const report = evaluateHarnessFluency({
      repoRoot: dir,
      modelPath,
      profile: "generic",
      mode: "deterministic",
      framing: "fluency",
      snapshotPath: path.join(dir, "latest.json"),
      compareLast: false,
      save: false,
    });

    const text = formatTextReport(report);
    expect(text).toContain("HARNESS FLUENCY REPORT");
    expect(text).toContain("Dimensions:");
    expect(text).toContain("Collaboration");
    expect(text).toContain("Recommended Next Actions:");

    fs.rmSync(dir, { recursive: true });
  });
});
