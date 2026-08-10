#!/usr/bin/env node
/**
 * Safe lifecycle helper for the generated Next.js development cache (`.next/`).
 *
 * Subcommands:
 *   clean     Remove only `<repoRoot>/.next`, refusing while a Routa dev server runs.
 *   diagnose  Report `.next` cache sizes and warn when the Turbopack dev cache
 *             (`.next/dev/cache/turbopack`) grows past the warning threshold.
 *
 * Safety contract:
 * - The deletion target is always `<repoRoot>/.next`, resolved from the location
 *   of this file. Environment variables never influence the deletion path.
 * - No globs and no user/home-relative paths are ever expanded for deletion.
 * - A symlinked or escaping `.next` directory is refused.
 * - `clean` exits non-zero with a clear error when a local dev server is
 *   detected (HTTP probe on the dev port plus a process-table scan).
 * - `npm run dev` never auto-cleans; cleanup is an explicit operator action.
 */

import { execFileSync } from "node:child_process";
/* global fetch, AbortSignal */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Warn when the Turbopack dev cache exceeds this size (2 GiB). */
export const CACHE_WARNING_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024;

const DEFAULT_DEV_PORT = 3000;
const PROBE_TIMEOUT_MS = 1500;

/**
 * Resolve the repository root from the directory this script lives in
 * (`<repoRoot>/scripts/dev`). Intentionally not derived from cwd or env vars.
 */
export function findRepoRoot(scriptDir) {
  return path.resolve(scriptDir, "..", "..");
}

/**
 * Resolve the only legal cleanup target: `<repoRoot>/.next`.
 * Throws when the target is a symlink or escapes the repository root.
 */
export function resolveNextCacheDir(repoRoot, fsImpl = fs) {
  const resolvedRoot = path.resolve(repoRoot);
  const cacheDir = path.join(resolvedRoot, ".next");

  if (path.dirname(cacheDir) !== resolvedRoot || path.basename(cacheDir) !== ".next") {
    throw new Error(`Refusing cleanup: resolved target ${cacheDir} is not <repoRoot>/.next.`);
  }

  if (fsImpl.existsSync(cacheDir)) {
    const stats = fsImpl.lstatSync(cacheDir);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing cleanup: ${cacheDir} is a symlink. Remove it manually after verifying its target.`);
    }
    const realPath = fsImpl.realpathSync(cacheDir);
    const realRoot = fsImpl.realpathSync(resolvedRoot);
    if (!realPath.startsWith(realRoot + path.sep)) {
      throw new Error(`Refusing cleanup: ${cacheDir} resolves outside the repository (${realPath}).`);
    }
  }

  return cacheDir;
}

/**
 * Extract lines that look like a running Next dev/start server from `ps` output.
 * Matches `next dev`, `next start`, and the `next-server` runtime process; does
 * not match builds or this helper script itself.
 *
 * @param {string} psOutput
 * @returns {string[]}
 */
export function parsePsOutputForDevServers(psOutput) {
  const matches = [];
  for (const rawLine of String(psOutput).split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.includes("next-dev-cache.mjs")) continue;
    if (/\bnext\s+dev\b/.test(line) || /\bnext-server\b/.test(line) || /\bnext\s+start\b/.test(line)) {
      matches.push(line);
    }
  }
  return matches;
}

function defaultPsRunner() {
  try {
    return execFileSync("ps", ["-eo", "args="], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/**
 * Probe one localhost port for a responding Next.js server.
 * Returns a descriptor when a Next server answers, otherwise null.
 *
 * @param {number} port
 * @param {(input: string, init?: RequestInit) => Promise<Response>} [fetchImpl]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ source: string; port: number; detail: string } | null>}
 */
export async function probeLocalNextServer(port, fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const poweredBy = response.headers?.get?.("x-powered-by") ?? "";
    if (/next\.js/i.test(poweredBy)) {
      return { source: "http", port, detail: `Next.js server responding on http://127.0.0.1:${port}/` };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ports worth probing: the default dev port plus PORT when it is a plain number.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number[]}
 */
export function resolveProbePorts(env = process.env) {
  const ports = new Set([DEFAULT_DEV_PORT]);
  const rawPort = env.PORT;
  if (rawPort && /^\d+$/.test(rawPort)) {
    ports.add(Number(rawPort));
  }
  return [...ports];
}

/**
 * Detect running Routa/Next dev servers via HTTP probe and process table scan.
 *
 * @param {{
 *   env?: Record<string, string | undefined>;
 *   fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
 *   psRunner?: () => string;
 * }} [options]
 * @returns {Promise<Array<{ source: string; detail: string; port?: number }>>}
 */
export async function detectRunningDevServers({
  env = process.env,
  fetchImpl = fetch,
  psRunner = defaultPsRunner,
} = {}) {
  const servers = [];

  for (const port of resolveProbePorts(env)) {
    const probe = await probeLocalNextServer(port, fetchImpl);
    if (probe) servers.push(probe);
  }

  const processMatches = parsePsOutputForDevServers(psRunner());
  for (const line of processMatches) {
    servers.push({ source: "process", detail: line });
  }

  return servers;
}

/** Recursively measure a directory. Returns bytes and file count. */
export function measureDirectory(dir, fsImpl = fs) {
  let totalBytes = 0;
  let fileCount = 0;

  const walk = (current) => {
    let entries;
    try {
      entries = fsImpl.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile()) {
        try {
          totalBytes += fsImpl.statSync(entryPath).size;
          fileCount += 1;
        } catch {
          // File disappeared mid-measurement; ignore.
        }
      }
    }
  };

  if (fsImpl.existsSync(dir)) {
    walk(dir);
  }
  return { totalBytes, fileCount };
}

/**
 * Build a cache-size report for `<repoRoot>/.next`.
 * Focuses on `.next/dev/cache/turbopack`, the cache that grew unbounded.
 *
 * @param {string} repoRoot
 * @param {{ thresholdBytes?: number; fsImpl?: typeof fs }} [options]
 */
export function buildCacheReport(repoRoot, { thresholdBytes = CACHE_WARNING_THRESHOLD_BYTES, fsImpl = fs } = {}) {
  const cacheDir = resolveNextCacheDir(repoRoot, fsImpl);
  const turbopackDir = path.join(cacheDir, "dev", "cache", "turbopack");

  const total = measureDirectory(cacheDir, fsImpl);
  const turbopack = measureDirectory(turbopackDir, fsImpl);

  return {
    cacheDir,
    exists: fsImpl.existsSync(cacheDir),
    totalBytes: total.totalBytes,
    totalFiles: total.fileCount,
    turbopackCacheDir: turbopackDir,
    turbopackBytes: turbopack.totalBytes,
    turbopackFiles: turbopack.fileCount,
    thresholdBytes,
    overThreshold: turbopack.totalBytes > thresholdBytes,
  };
}

/**
 * Remove `<repoRoot>/.next` after verifying no dev server is running.
 * Returns a structured result; the CLI maps refusals to a non-zero exit code.
 *
 * @param {{
 *   repoRoot: string;
 *   detect?: () => Promise<Array<{ source: string; detail: string; port?: number }>>;
 *   fsImpl?: typeof fs;
 * }} [options]
 */
export async function cleanNextCache({
  repoRoot,
  detect = detectRunningDevServers,
  fsImpl = fs,
} = {}) {
  const cacheDir = resolveNextCacheDir(repoRoot, fsImpl);

  if (!fsImpl.existsSync(cacheDir)) {
    return { cleaned: false, skipped: true, cacheDir, message: `No generated cache at ${cacheDir}; nothing to clean.` };
  }

  const runningServers = await detect();
  if (runningServers.length > 0) {
    const details = runningServers.map((server) => `  - ${server.detail}`).join("\n");
    return {
      cleaned: false,
      refused: true,
      cacheDir,
      servers: runningServers,
      message:
        "Refusing to clean the Next dev cache while a Routa dev server is running.\n" +
        "Detected server(s):\n" +
        `${details}\n` +
        "Stop the dev server first, then re-run `npm run dev:clean`.",
    };
  }

  fsImpl.rmSync(cacheDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  return { cleaned: true, cacheDir, message: `Removed generated cache at ${cacheDir}.` };
}

export function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

async function runDiagnose(repoRoot) {
  const report = buildCacheReport(repoRoot);

  if (!report.exists) {
    console.log(`No generated cache found at ${report.cacheDir}. Nothing to diagnose.`);
    return 0;
  }

  console.log("Next dev cache report");
  console.log(`  .next total:                 ${formatBytes(report.totalBytes)} (${report.totalFiles} files)`);
  console.log(`  .next/dev/cache/turbopack:   ${formatBytes(report.turbopackBytes)} (${report.turbopackFiles} files)`);
  console.log(`  Warning threshold:           ${formatBytes(report.thresholdBytes)}`);

  if (report.overThreshold) {
    console.warn(
      `\nWARNING: Turbopack dev cache exceeds ${formatBytes(report.thresholdBytes)}. ` +
        "Stop the dev server and run `npm run dev:clean`, then restart the selected bundler.",
    );
  } else {
    console.log("\nCache size is below the warning threshold.");
  }
  return 0;
}

async function runClean(repoRoot) {
  const result = await cleanNextCache({ repoRoot });
  if (result.refused) {
    console.error(result.message);
    return 1;
  }
  console.log(result.message);
  if (result.cleaned) {
    console.log("Restart the dev server with `npm run dev` (Webpack) or `npm run dev:turbopack`.");
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(scriptDir);
  const command = argv[0];

  try {
    if (command === "clean") {
      return await runClean(repoRoot);
    }
    if (command === "diagnose") {
      return await runDiagnose(repoRoot);
    }
    console.error("Usage: node scripts/dev/next-dev-cache.mjs <clean|diagnose>");
    return 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().then((code) => {
    process.exitCode = code;
  });
}
