import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the metric runner to avoid actually spawning shell commands
vi.mock("../fitness-metric-runner", () => ({
  runMetrics: vi.fn(async (metrics: Array<{ name: string; tier: string; hard_gate: boolean }>) =>
    metrics.map((m) => ({
      name: m.name,
      passed: m.name !== "failing_metric",
      state: m.name === "failing_metric" ? "fail" : m.name === "skipped_metric" ? "skipped" : "pass",
      tier: m.tier,
      hard_gate: m.hard_gate,
      duration_ms: 100,
      output: m.name === "failing_metric" ? "check failed" : "ok",
    })),
  ),
}));

import { runMetrics } from "../fitness-metric-runner";
import { executeNodeFitnessRun } from "../node-fitness-engine";

const mockRunMetrics = vi.mocked(runMetrics);

describe("node-fitness-engine", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fitness-engine-"));
    fs.mkdirSync(path.join(tempDir, "docs", "fitness"), { recursive: true });

    // Write a minimal manifest and dimension file
    fs.writeFileSync(
      path.join(tempDir, "docs", "fitness", "manifest.yaml"),
      `schema: fitness-manifest-v1
evidence_files:
  - docs/fitness/test-quality.md
  - docs/fitness/test-security.md
`,
    );

    fs.writeFileSync(
      path.join(tempDir, "docs", "fitness", "test-quality.md"),
      `---
dimension: code_quality
weight: 80
tier: normal
metrics:
  - name: passing_metric
    command: echo ok
    hard_gate: false
    tier: fast
  - name: failing_metric
    command: exit 1
    hard_gate: true
    tier: fast
  - name: normal_metric
    command: echo ok
    hard_gate: false
    tier: normal
  - name: skipped_metric
    command: echo skip
    hard_gate: false
    tier: fast
---
# Test
`,
    );

    fs.writeFileSync(
      path.join(tempDir, "docs", "fitness", "test-security.md"),
      `---
dimension: security
weight: 20
tier: normal
metrics:
  - name: audit_pass
    command: echo ok
    hard_gate: true
    tier: fast
---
# Security
`,
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("produces a complete run result with snake_case report", async () => {
    const result = await executeNodeFitnessRun({
      repoRoot: tempDir,
      tier: "fast",
      scope: "local",
    });

    expect(result.tier).toBe("fast");
    expect(result.scope).toBe("local");
    expect(result.command).toBe("node");
    expect(result.durationMs).toBeGreaterThan(0);
    expect(typeof result.exitCode).toBe("number");

    // Verify snake_case report shape
    expect(result.rawReport).toHaveProperty("final_score");
    expect(result.rawReport).toHaveProperty("hard_gate_blocked");
    expect(result.rawReport).toHaveProperty("score_blocked");
    expect(result.rawReport).toHaveProperty("runtime_timed_out");
    expect(result.rawReport).toHaveProperty("dimensions");

    const dims = result.rawReport.dimensions as Array<Record<string, unknown>>;
    expect(dims.length).toBe(2);

    // Each dimension should have the correct shape
    for (const dim of dims) {
      expect(dim).toHaveProperty("name");
      expect(dim).toHaveProperty("weight");
      expect(dim).toHaveProperty("score");
      expect(dim).toHaveProperty("passed");
      expect(dim).toHaveProperty("total");
      expect(dim).toHaveProperty("hard_gate_failures");
      expect(dim).toHaveProperty("results");
    }
  });

  it("filters metrics by tier (fast only includes fast metrics)", async () => {
    await executeNodeFitnessRun({
      repoRoot: tempDir,
      tier: "fast",
      scope: "local",
    });

    // runMetrics should be called once per dimension
    expect(mockRunMetrics).toHaveBeenCalledTimes(2);

    // First call: code_quality dimension with fast-tier metrics only
    const firstCallMetrics = mockRunMetrics.mock.calls[0]?.[0] ?? [];
    expect(firstCallMetrics.every((m: { tier: string }) => m.tier === "fast")).toBe(true);
    // Should NOT include normal_metric
    expect(firstCallMetrics.find((m: { name: string }) => m.name === "normal_metric")).toBeUndefined();
  });

  it("includes normal-tier metrics when tier is normal", async () => {
    await executeNodeFitnessRun({
      repoRoot: tempDir,
      tier: "normal",
      scope: "local",
    });

    const firstCallMetrics = mockRunMetrics.mock.calls[0]?.[0] ?? [];
    // Should include the normal_metric now
    expect(firstCallMetrics.find((m: { name: string }) => m.name === "normal_metric")).toBeTruthy();
  });

  it("detects hard gate blocking and returns exit code 2", async () => {
    const result = await executeNodeFitnessRun({
      repoRoot: tempDir,
      tier: "fast",
      scope: "local",
    });

    // The mock returns failing_metric as failed with hard_gate=true
    expect(result.rawReport.hard_gate_blocked).toBe(true);
    expect(result.exitCode).toBe(2);
  });

  it("excludes skipped metrics from scoring", async () => {
    const result = await executeNodeFitnessRun({
      repoRoot: tempDir,
      tier: "fast",
      scope: "local",
    });

    const dims = result.rawReport.dimensions as Array<{ name: string; passed: number; total: number }>;
    const codeQuality = dims.find((d) => d.name === "code_quality");
    expect(codeQuality).toBeTruthy();
    // 3 fast metrics: passing_metric, failing_metric, skipped_metric
    // skipped is excluded from scoring, so total = 2 (pass + fail)
    expect(codeQuality?.total).toBe(2);
    expect(codeQuality?.passed).toBe(1);
  });

  it("filters to a single dimension when dimension param is set", async () => {
    const result = await executeNodeFitnessRun({
      repoRoot: tempDir,
      tier: "fast",
      scope: "local",
      dimension: "security",
    });

    const dims = result.rawReport.dimensions as Array<{ name: string }>;
    expect(dims.length).toBe(1);
    expect(dims[0]?.name).toBe("security");

    // runMetrics should only be called once (for security dimension)
    expect(mockRunMetrics).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error for an unknown dimension name", async () => {
    await expect(
      executeNodeFitnessRun({
        repoRoot: tempDir,
        tier: "fast",
        scope: "local",
        dimension: "nonexistent_dimension",
      }),
    ).rejects.toThrow(/Unknown fitness dimension.*nonexistent_dimension/);
  });

  it("runs all dimensions when dimension param is omitted", async () => {
    const result = await executeNodeFitnessRun({
      repoRoot: tempDir,
      tier: "fast",
      scope: "local",
    });

    const dims = result.rawReport.dimensions as Array<{ name: string }>;
    expect(dims.length).toBe(2);
    expect(dims.map((d) => d.name).sort()).toEqual(["code_quality", "security"]);
  });
});
