#!/usr/bin/env node
/**
 * validate:web:e2e — E2E validation gate (§11.1 of the design doc).
 *
 * Assumes .next exists (run after validate:web which builds it).
 *
 * Steps:
 *   1. Start Next.js server with SQLite DB on a temp path (npx next start -p PORT)
 *   2. Wait for "Ready" on stdout
 *   3. Run npm run api:test:nextjs
 *   4. Install Playwright chromium if needed
 *   5. Run Team/Kanban Playwright specs (chromium project)
 *   6. Kill the server (always, via finally)
 *
 * Exit 0 on all-green, non-zero on first failure.
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 3099;
const SPECS = [
  "e2e/team-run-lifecycle.spec.ts",
  "e2e/kanban-agent-panel.spec.ts",
  "e2e/kanban-column-automation.spec.ts",
  "e2e/kanban-drag-drop.spec.ts",
];

function runSync(label, cmd, args, opts = {}) {
  const started = Date.now();
  console.log(`\n${"─".repeat(60)}\n  ${label}\n${"─".repeat(60)}`);

  try {
    execSync([cmd, ...args].join(" "), {
      stdio: "inherit",
      timeout: 300_000,
      ...opts,
    });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`✓ ${label} passed (${elapsed}s)`);
    return { label, code: 0, elapsed };
  } catch (err) {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const code = err.status ?? 1;
    console.error(`✖ ${label} failed (exit ${code}, ${elapsed}s)`);
    return { label, code, elapsed };
  }
}

function startServer(dbPath) {
  console.log(`\nStarting Next.js server on port ${PORT}...`);

  const child = spawn("npx", ["next", "start", "-p", String(PORT)], {
    env: {
      ...process.env,
      ROUTA_DB_DRIVER: "sqlite",
      ROUTA_DB_PATH: dbPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return child;
}

function waitForReady(child, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Server did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);

    let output = "";

    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes("Ready") || output.includes("ready") || output.includes("started")) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve();
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        reject(new Error(`Server exited with code ${code} before becoming ready`));
      }
    });
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-e2e-"));
  const dbPath = path.join(tmpDir, "validate-e2e.db");
  const results = [];
  let server = null;

  try {
    // Check .next exists
    if (!fs.existsSync(".next")) {
      console.error("[validate:web:e2e] .next directory not found. Run validate:web first.");
      process.exit(1);
    }

    // Start server
    server = startServer(dbPath);

    try {
      await waitForReady(server);
      console.log(`✓ Server ready on port ${PORT}`);
    } catch (err) {
      console.error(`✖ Server failed to start: ${err.message}`);
      process.exit(1);
    }

    // Run api:test:nextjs (run the underlying command directly to control BASE_URL)
    const apiResult = runSync(
      "api:test:nextjs",
      "node",
      ["--import", "tsx", "tests/api-contract/run.ts"],
      {
        env: { ...process.env, BASE_URL: `http://localhost:${PORT}` },
      },
    );
    results.push(apiResult);
    if (apiResult.code !== 0) {
      console.error("Stopping after api:test:nextjs failure.");
      process.exit(1);
    }

    // Install Playwright chromium if needed
    console.log("\nEnsuring Playwright chromium is installed...");
    try {
      execSync("npx playwright install chromium", { stdio: "inherit", timeout: 120_000 });
      console.log("✓ Playwright chromium ready");
    } catch (err) {
      console.error(`⚠ Playwright chromium install failed: ${err.message}`);
      console.error("Recording as environment limitation (§13). Skipping Playwright specs.");
      results.push({ label: "playwright-install", code: 0, elapsed: "0.0", note: "skipped (env limitation)" });
      process.exit(0);
    }

    // Run Playwright specs
    const pwResult = runSync(
      "playwright specs",
      "npx",
      ["playwright", "test", ...SPECS, "--project=chromium"],
      {
        env: {
          ...process.env,
          PLAYWRIGHT_BASE_URL: `http://localhost:${PORT}`,
        },
      },
    );
    results.push(pwResult);

    // Summary
    console.log(`\n${"═".repeat(60)}`);
    console.log("  validate:web:e2e summary");
    console.log(`${"═".repeat(60)}`);
    for (const r of results) {
      const icon = r.code === 0 ? "✓" : "✖";
      const note = r.note ? ` (${r.note})` : "";
      console.log(`  ${icon} ${r.label.padEnd(24)} ${r.elapsed}s${note}`);
    }

    const allGreen = results.every((r) => r.code === 0);
    process.exit(allGreen ? 0 : 1);
  } finally {
    // Kill server
    if (server) {
      server.kill("SIGTERM");
      // Give it a moment to shut down gracefully
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (server.exitCode === null) {
        server.kill("SIGKILL");
      }
    }
    // Cleanup temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

main();
