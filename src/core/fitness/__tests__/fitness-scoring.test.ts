import { describe, expect, it } from "vitest";

import {
  enforceExitCode,
  scoreDimension,
  scoreReport,
  type FitnessMetricResult,
} from "../fitness-scoring";

function makeResult(
  name: string,
  passed: boolean,
  state: "pass" | "fail" | "waived" | "skipped" | "unknown",
  hardGate = false,
): FitnessMetricResult {
  return {
    name,
    passed,
    state,
    tier: "fast",
    hard_gate: hardGate,
    duration_ms: 100,
    output: "",
  };
}

describe("fitness-scoring", () => {
  describe("scoreDimension", () => {
    it("scores all-pass results as 100%", () => {
      const results = [
        makeResult("a", true, "pass"),
        makeResult("b", true, "pass"),
      ];
      const ds = scoreDimension(results, "quality", 24);
      expect(ds.score).toBe(100);
      expect(ds.passed).toBe(2);
      expect(ds.total).toBe(2);
      expect(ds.hard_gate_failures).toEqual([]);
    });

    it("scores partial pass correctly", () => {
      const results = [
        makeResult("a", true, "pass"),
        makeResult("b", false, "fail"),
      ];
      const ds = scoreDimension(results, "quality", 24);
      expect(ds.score).toBe(50);
      expect(ds.passed).toBe(1);
      expect(ds.total).toBe(2);
    });

    it("records hard gate failures", () => {
      const results = [makeResult("lint", false, "fail", true)];
      const ds = scoreDimension(results, "quality", 24);
      expect(ds.hard_gate_failures).toEqual(["lint"]);
    });

    it("returns 0 for empty results", () => {
      const ds = scoreDimension([], "empty", 10);
      expect(ds.score).toBe(0);
      expect(ds.total).toBe(0);
    });

    it("ignores unknown and skipped states in scoring", () => {
      const results = [
        makeResult("pass", true, "pass"),
        makeResult("unknown", false, "unknown"),
        makeResult("skipped", false, "skipped"),
      ];
      const ds = scoreDimension(results, "quality", 100);
      expect(ds.passed).toBe(1);
      expect(ds.total).toBe(1);
      expect(ds.score).toBe(100);
    });

    it("counts waived as pass in scoring", () => {
      const results = [
        makeResult("waived", true, "waived"),
        makeResult("fail", false, "fail"),
      ];
      const ds = scoreDimension(results, "quality", 100);
      expect(ds.passed).toBe(1);
      expect(ds.total).toBe(2);
      expect(ds.score).toBe(50);
    });
  });

  describe("scoreReport", () => {
    it("computes weighted score correctly", () => {
      const ds_a = scoreDimension([makeResult("a", true, "pass")], "high_weight", 80);
      const ds_b = scoreDimension([makeResult("b", false, "fail")], "low_weight", 20);
      const report = scoreReport([ds_a, ds_b], 80);
      // (100 * 80 + 0 * 20) / 100 = 80.0
      expect(report.final_score).toBe(80);
      expect(report.hard_gate_blocked).toBe(false);
      expect(report.score_blocked).toBe(false); // 80 >= 80
    });

    it("detects hard gate blocking", () => {
      const ds = scoreDimension(
        [makeResult("gate", false, "fail", true)],
        "sec",
        20,
      );
      const report = scoreReport([ds], 80);
      expect(report.hard_gate_blocked).toBe(true);
    });

    it("detects score blocking", () => {
      const results = [
        makeResult("a", true, "pass"),
        makeResult("b", false, "fail"),
        makeResult("c", false, "fail"),
      ];
      const ds = scoreDimension(results, "quality", 100);
      const report = scoreReport([ds], 80);
      // 33.3% < 80%
      expect(report.score_blocked).toBe(true);
    });

    it("does not block when no scorable weight exists", () => {
      const ds = scoreDimension(
        [makeResult("probe", false, "skipped")],
        "observability",
        0,
      );
      const report = scoreReport([ds], 80);
      expect(report.final_score).toBe(0);
      expect(report.score_blocked).toBe(false);
    });

    it("excludes zero-total dimensions from weighted average", () => {
      const scored = scoreDimension([makeResult("lint", true, "pass")], "quality", 80);
      const skippedOnly = scoreDimension(
        [makeResult("probe", false, "skipped")],
        "observability",
        20,
      );
      const report = scoreReport([scored, skippedOnly], 80);
      expect(report.final_score).toBe(100);
      expect(report.score_blocked).toBe(false);
    });
  });

  describe("enforceExitCode", () => {
    it("returns 0 for passing report", () => {
      const ds = scoreDimension([makeResult("a", true, "pass")], "quality", 100);
      const report = scoreReport([ds], 80);
      expect(enforceExitCode(report)).toBe(0);
    });

    it("returns 1 for score below threshold", () => {
      const ds = scoreDimension(
        [makeResult("a", true, "pass"), makeResult("b", false, "fail"), makeResult("c", false, "fail")],
        "quality",
        100,
      );
      const report = scoreReport([ds], 80);
      expect(enforceExitCode(report)).toBe(1);
    });

    it("returns 2 for hard gate failure", () => {
      const ds = scoreDimension(
        [makeResult("gate", false, "fail", true)],
        "sec",
        20,
      );
      const report = scoreReport([ds], 80);
      expect(enforceExitCode(report)).toBe(2);
    });

    it("returns 2 for runtime timeout", () => {
      const ds = scoreDimension([makeResult("a", true, "pass")], "quality", 100);
      const report = { ...scoreReport([ds], 80), runtime_timed_out: true };
      expect(enforceExitCode(report)).toBe(2);
    });
  });
});
