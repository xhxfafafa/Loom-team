import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../fitness/check-backend-architecture";

const tempRoots: string[] = [];

function makeTempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-backend-architecture-"));
  tempRoots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string, contents: string): void {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents, "utf8");
}

function baseDsl(extraRules: string[] = []): string {
  return [
    "schema: routa.archdsl/v1",
    "model:",
    "  id: fixture",
    "  title: Fixture",
    "selectors:",
    "  core_ts:",
    "    kind: files",
    "    language: typescript",
    '    include: ["src/core/**"]',
    "  app_ts:",
    "    kind: files",
    "    language: typescript",
    '    include: ["src/app/**"]',
    "rules:",
    ...extraRules,
    "",
  ].join("\n");
}

const boundaryRule = [
  "  - id: no_core_to_app",
  "    title: core must not depend on app",
  "    kind: dependency",
  "    suite: boundaries",
  "    severity: advisory",
  "    from: core_ts",
  "    relation: must_not_depend_on",
  "    to: app_ts",
  "    engine_hints: [graph]",
];

const cycleRule = [
  "  - id: no_cycles",
  "    title: core should be cycle free",
  "    kind: cycle",
  "    suite: cycles",
  "    severity: advisory",
  "    scope: core_ts",
  "    relation: must_be_acyclic",
  "    engine_hints: [graph]",
];

const archUnitRule = [
  "  - id: archunitts_only",
  "    title: archunitts handled elsewhere",
  "    kind: dependency",
  "    suite: boundaries",
  "    severity: advisory",
  "    from: core_ts",
  "    relation: must_not_depend_on",
  "    to: app_ts",
  "    engine_hints: [archunitts]",
];

let stdout: string[] = [];
let stderr: string[] = [];

function captureConsole(): void {
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.join(" "));
  });
}

function parsedStdout(): Record<string, unknown> {
  return JSON.parse(stdout.join("\n")) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("check-backend-architecture suite runner", () => {
  it("reports dependency violations for the boundaries suite", async () => {
    const root = makeTempRepo();
    const dslPath = path.join(root, "rules.archdsl.yaml");
    writeFile(root, "rules.archdsl.yaml", baseDsl(boundaryRule));
    writeFile(
      root,
      "src/core/bad.ts",
      'import { target } from "@/app/target";\nexport const bad = 1;\n',
    );
    writeFile(root, "src/app/target.ts", "export const target = 1;\n");

    captureConsole();
    const exitCode = await main([
      "--repo-root",
      root,
      "--suite",
      "boundaries",
      "--json",
      "--dsl",
      dslPath,
    ]);

    expect(exitCode).toBe(1);
    const report = parsedStdout();
    expect(report.suite).toBe("boundaries");
    expect(report.summaryStatus).toBe("fail");
    expect(report.ruleCount).toBe(1);
    expect(report.failedRuleCount).toBe(1);
    expect(report.archUnitSource).toBe("scripts/fitness/check-backend-architecture.ts");
    expect(report.tsconfigPath).toBe(path.join(root, "tsconfig.json"));

    const results = report.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "no_core_to_app",
      status: "fail",
      violationCount: 1,
    });
    expect(results[0].violations).toEqual([
      {
        kind: "dependency",
        source: "src/core/bad.ts",
        target: "src/app/target.ts",
        edgeCount: 1,
      },
    ]);
  });

  it("reports cycle violations for the cycles suite", async () => {
    const root = makeTempRepo();
    const dslPath = path.join(root, "rules.archdsl.yaml");
    writeFile(root, "rules.archdsl.yaml", baseDsl(cycleRule));
    writeFile(root, "src/core/bad.ts", 'import { b } from "./b";\n');
    writeFile(root, "src/core/b.ts", 'import { bad } from "./bad";\n');

    captureConsole();
    const exitCode = await main([
      "--repo-root",
      root,
      "--suite",
      "cycles",
      "--json",
      "--dsl",
      dslPath,
    ]);

    expect(exitCode).toBe(1);
    const report = parsedStdout();
    expect(report.summaryStatus).toBe("fail");
    const results = report.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0].violations).toEqual([
      {
        kind: "cycle",
        path: ["src/core/b.ts", "src/core/bad.ts"],
        edgeCount: 2,
      },
    ]);
  });

  it("passes a clean repository for both suites", async () => {
    const root = makeTempRepo();
    const dslPath = path.join(root, "rules.archdsl.yaml");
    writeFile(root, "rules.archdsl.yaml", baseDsl([...boundaryRule, ...cycleRule]));
    writeFile(root, "src/core/ok.ts", "export const ok = 1;\n");
    writeFile(root, "src/app/other.ts", 'import { ok } from "@/core/ok";\n');

    for (const suite of ["boundaries", "cycles"]) {
      captureConsole();
      const exitCode = await main([
        "--repo-root",
        root,
        "--suite",
        suite,
        "--json",
        "--dsl",
        dslPath,
      ]);
      expect(exitCode).toBe(0);
      const report = parsedStdout();
      expect(report.summaryStatus).toBe("pass");
      expect(report.failedRuleCount).toBe(0);
    }
  });

  it("skips suites that have no rules", async () => {
    const root = makeTempRepo();
    const dslPath = path.join(root, "rules.archdsl.yaml");
    writeFile(root, "rules.archdsl.yaml", baseDsl(boundaryRule));
    writeFile(root, "src/core/ok.ts", "export const ok = 1;\n");

    captureConsole();
    const exitCode = await main([
      "--repo-root",
      root,
      "--suite",
      "cycles",
      "--json",
      "--dsl",
      dslPath,
    ]);

    expect(exitCode).toBe(0);
    const report = parsedStdout();
    expect(report.summaryStatus).toBe("skipped");
    expect(report.ruleCount).toBe(0);
    expect(report.archUnitSource).toBeNull();
  });

  it("marks archunitts-only rules as unknown violations with a note", async () => {
    const root = makeTempRepo();
    const dslPath = path.join(root, "rules.archdsl.yaml");
    writeFile(root, "rules.archdsl.yaml", baseDsl(archUnitRule));
    writeFile(root, "src/core/ok.ts", "export const ok = 1;\n");

    captureConsole();
    const exitCode = await main([
      "--repo-root",
      root,
      "--suite",
      "boundaries",
      "--json",
      "--dsl",
      dslPath,
    ]);

    expect(exitCode).toBe(1);
    const report = parsedStdout();
    expect(report.summaryStatus).toBe("fail");
    expect(report.notes).toEqual([
      "ArchUnitTS-compatible rules are planned here but still execute through scripts/fitness/check-backend-architecture.ts",
    ]);
    const results = report.results as Array<Record<string, unknown>>;
    expect(results[0].violations).toEqual([
      {
        kind: "unknown",
        summary: "archunitts rules are intentionally executed via the TypeScript fitness path",
      },
    ]);
  });

  it("rejects an unknown suite name", async () => {
    captureConsole();
    const exitCode = await main(["--suite", "bogus"]);
    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("invalid suite 'bogus'");
  });

  it("fails when the DSL file cannot be loaded", async () => {
    const root = makeTempRepo();
    captureConsole();
    const exitCode = await main([
      "--repo-root",
      root,
      "--dsl",
      path.join(root, "missing.archdsl.yaml"),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("no such file");
  });

  it("prints a text report without --json", async () => {
    const root = makeTempRepo();
    const dslPath = path.join(root, "rules.archdsl.yaml");
    writeFile(root, "rules.archdsl.yaml", baseDsl(cycleRule));
    writeFile(root, "src/core/ok.ts", "export const ok = 1;\n");

    captureConsole();
    const exitCode = await main(["--repo-root", root, "--suite", "cycles", "--dsl", dslPath]);

    expect(exitCode).toBe(0);
    // Text reports go to stdout via process.stdout.write; console.log stays quiet.
    expect(stdout).toHaveLength(0);
  });
});
