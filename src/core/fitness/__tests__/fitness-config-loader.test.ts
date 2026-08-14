import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  extractFrontmatter,
  filterByScope,
  filterByTier,
  loadFitnessConfig,
  type MetricDefinition,
} from "../fitness-config-loader";

describe("fitness-config-loader", () => {
  describe("extractFrontmatter", () => {
    it("parses valid YAML frontmatter", () => {
      const content = `---
dimension: code_quality
weight: 18
tier: normal
---

# Content
`;
      const fm = extractFrontmatter(content);
      expect(fm).toBeTruthy();
      expect(fm?.dimension).toBe("code_quality");
      expect(fm?.weight).toBe(18);
    });

    it("returns null for content without frontmatter", () => {
      expect(extractFrontmatter("# No frontmatter")).toBeNull();
    });

    it("returns null for malformed YAML", () => {
      const content = `---
: : : invalid yaml [
---`;
      expect(extractFrontmatter(content)).toBeNull();
    });
  });

  describe("filterByTier", () => {
    const metrics: MetricDefinition[] = [
      { name: "fast_m", command: "echo", hard_gate: false, tier: "fast" },
      { name: "normal_m", command: "echo", hard_gate: false, tier: "normal" },
      { name: "deep_m", command: "echo", hard_gate: false, tier: "deep" },
    ];

    it("fast tier includes only fast metrics", () => {
      expect(filterByTier(metrics, "fast")).toHaveLength(1);
      expect(filterByTier(metrics, "fast")[0]?.name).toBe("fast_m");
    });

    it("normal tier includes fast and normal metrics", () => {
      expect(filterByTier(metrics, "normal")).toHaveLength(2);
    });

    it("deep tier includes all metrics", () => {
      expect(filterByTier(metrics, "deep")).toHaveLength(3);
    });
  });

  describe("filterByScope", () => {
    const metrics: MetricDefinition[] = [
      { name: "local_m", command: "echo", hard_gate: false, tier: "fast", execution_scope: "local" },
      { name: "ci_m", command: "echo", hard_gate: false, tier: "fast", execution_scope: "ci" },
      { name: "default_m", command: "echo", hard_gate: false, tier: "fast" },
    ];

    it("local scope includes local and unscoped metrics", () => {
      const filtered = filterByScope(metrics, "local");
      expect(filtered).toHaveLength(2);
      expect(filtered.map((m) => m.name)).toEqual(["local_m", "default_m"]);
    });

    it("ci scope includes only ci metrics", () => {
      const filtered = filterByScope(metrics, "ci");
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.name).toBe("ci_m");
    });
  });

  describe("loadFitnessConfig", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fitness-config-"));
      fs.mkdirSync(path.join(tempDir, "docs", "fitness"), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("loads dimensions from manifest and frontmatter", () => {
      fs.writeFileSync(
        path.join(tempDir, "docs", "fitness", "manifest.yaml"),
        "schema: fitness-manifest-v1\nevidence_files:\n  - docs/fitness/test-quality.md\n",
      );

      fs.writeFileSync(
        path.join(tempDir, "docs", "fitness", "test-quality.md"),
        `---
dimension: code_quality
weight: 18
tier: normal
metrics:
  - name: eslint_pass
    command: npx eslint
    hard_gate: true
    tier: fast
  - name: typecheck
    command: tsc --noEmit
    hard_gate: true
    tier: fast
---
# Test
`,
      );

      const config = loadFitnessConfig(tempDir);
      expect(config.dimensions).toHaveLength(1);
      expect(config.dimensions[0]?.name).toBe("code_quality");
      expect(config.dimensions[0]?.weight).toBe(18);
      expect(config.dimensions[0]?.metrics).toHaveLength(2);
    });

    it("throws when manifest is missing", () => {
      expect(() => loadFitnessConfig(tempDir)).toThrow("manifest not found");
    });

    it("skips evidence files that don't exist", () => {
      fs.writeFileSync(
        path.join(tempDir, "docs", "fitness", "manifest.yaml"),
        "schema: fitness-manifest-v1\nevidence_files:\n  - docs/fitness/missing.md\n",
      );

      const config = loadFitnessConfig(tempDir);
      expect(config.dimensions).toHaveLength(0);
    });

    it("loads real manifest from target repo", () => {
      // This tests against the actual docs/fitness/manifest.yaml in the repo
      const repoRoot = path.resolve(__dirname, "../../../../");
      const manifestPath = path.join(repoRoot, "docs", "fitness", "manifest.yaml");
      if (!fs.existsSync(manifestPath)) {
        return; // Skip if running outside the repo
      }

      const config = loadFitnessConfig(repoRoot);
      expect(config.dimensions.length).toBeGreaterThan(0);

      // Verify key dimensions exist
      const dimNames = config.dimensions.map((d) => d.name);
      expect(dimNames).toContain("code_quality");
      expect(dimNames).toContain("security");
      expect(dimNames).toContain("testability");

      // Verify fast/local metric count (should be ~13 per the migration spec)
      let fastLocalCount = 0;
      for (const dim of config.dimensions) {
        const filtered = filterByScope(filterByTier(dim.metrics, "fast"), "local");
        fastLocalCount += filtered.length;
      }
      expect(fastLocalCount).toBeGreaterThanOrEqual(10);
    });
  });
});
