import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fromRoot } from "../lib/paths";

function runFitnessCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", fromRoot("scripts/fitness/run-fitness.ts"), ...args],
    {
      cwd: fromRoot(),
      encoding: "utf8",
      timeout: 120_000,
    },
  );
}

describe("run-fitness CLI", () => {
  it("runs a single dimension and produces a valid report JSON file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fitness-cli-"));
    const outFile = path.join(tmpDir, "report.json");

    try {
      const result = runFitnessCli([
        "--dimension",
        "api_contract",
        "--tier",
        "fast",
        "--scope",
        "local",
        "--min-score",
        "0",
        "--output",
        outFile,
      ]);

      // Exit 0 with min-score=0 (no score blocking)
      expect(result.status).toBe(0);

      // Stdout should contain the summary line
      expect(result.stdout).toContain("final_score=");
      expect(result.stdout).toContain("api_contract");

      // Output file should exist and be valid JSON with expected keys
      expect(fs.existsSync(outFile)).toBe(true);
      const report = JSON.parse(fs.readFileSync(outFile, "utf-8")) as Record<string, unknown>;
      expect(report).toHaveProperty("final_score");
      expect(report).toHaveProperty("dimensions");
      expect(report).toHaveProperty("hard_gate_blocked");
      expect(report).toHaveProperty("score_blocked");
      expect(report).toHaveProperty("runtime_timed_out");

      const dims = report.dimensions as Array<{ name: string }>;
      expect(dims.length).toBe(1);
      expect(dims[0]?.name).toBe("api_contract");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits with code 2 for an unknown dimension", () => {
    const result = runFitnessCli([
      "--dimension",
      "nonexistent_dim",
      "--tier",
      "fast",
      "--scope",
      "local",
      "--min-score",
      "0",
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown fitness dimension");
  });

  it("rejects unknown flags", () => {
    const result = runFitnessCli(["--bogus-flag"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown flag");
  });
});
