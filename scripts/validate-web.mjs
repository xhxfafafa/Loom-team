#!/usr/bin/env node
/**
 * validate:web — aggregate Web-only validation gate (§11.1 of the design doc).
 *
 * Runs the static/build gates in order, stopping at first failure.
 *
 * Steps:
 *   1. npm run lint
 *   2. npx tsc --noEmit
 *   3. npm run api:schema:validate
 *   4. npx --yes dependency-cruiser --config .dependency-cruiser.cjs src --validate
 *   5. npm run test:run
 *   6. npm run snapshots:validate
 *   7. npm run build
 *
 * Exit 0 on all-green, non-zero on first failure.
 */

import { spawn } from "node:child_process";

const STEPS = [
  { label: "lint",                cmd: "npm",  args: ["run", "lint"] },
  { label: "tsc --noEmit",        cmd: "npx",  args: ["tsc", "--noEmit"] },
  { label: "api:schema:validate", cmd: "npm",  args: ["run", "api:schema:validate"] },
  { label: "dependency-cruiser",  cmd: "npx",  args: ["--yes", "dependency-cruiser", "--config", ".dependency-cruiser.cjs", "src", "--validate"] },
  { label: "test:run",            cmd: "npm",  args: ["run", "test:run"] },
  { label: "snapshots:validate",  cmd: "npm",  args: ["run", "snapshots:validate"] },
  { label: "build",               cmd: "npm",  args: ["run", "build"] },
];

function runStep(label, cmd, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    const banner = `\n${"─".repeat(60)}\n  ${label}\n${"─".repeat(60)}`;
    console.log(banner);

    const child = spawn(cmd, args, {
      stdio: "inherit",
      env: { ...process.env },
    });

    child.on("close", (code) => {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      resolve({ label, code: code ?? 1, elapsed });
    });

    child.on("error", (err) => {
      console.error(`[validate:web] ${label} failed to start: ${err.message}`);
      resolve({ label, code: 127, elapsed: "0.0" });
    });
  });
}

async function main() {
  const overallStart = Date.now();
  const results = [];
  let failed = false;

  for (const step of STEPS) {
    const result = await runStep(step.label, step.cmd, step.args);
    results.push(result);

    if (result.code !== 0) {
      console.error(`\n✖ ${step.label} failed (exit ${result.code})`);
      failed = true;
      break;
    }

    console.log(`✓ ${step.label} passed (${result.elapsed}s)`);
  }

  const overallElapsed = ((Date.now() - overallStart) / 1000).toFixed(1);

  // Summary table
  console.log(`\n${"═".repeat(60)}`);
  console.log("  validate:web summary");
  console.log(`${"═".repeat(60)}`);

  for (const r of results) {
    const icon = r.code === 0 ? "✓" : "✖";
    console.log(`  ${icon} ${r.label.padEnd(24)} ${r.elapsed}s`);
  }

  if (!failed) {
    console.log(`\nAll ${results.length} gates passed in ${overallElapsed}s.`);
    process.exit(0);
  } else {
    console.log(`\nFailed at step "${results[results.length - 1]?.label}" after ${overallElapsed}s.`);
    process.exit(1);
  }
}

main();
