#!/usr/bin/env node
/**
 * API Parity Checker (Web-only)
 *
 * Extracts route definitions from two sources and detects differences:
 *   1. api-contract.yaml  — the source of truth
 *   2. Next.js routes     — src/app/api/ filesystem convention
 *
 * Usage:
 *   node --import tsx scripts/fitness/check-api-parity.ts
 *   node --import tsx scripts/fitness/check-api-parity.ts --json        # machine-readable output
 *   node --import tsx scripts/fitness/check-api-parity.ts --fix-hint    # show suggested fixes
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { getCliArgs, isDirectExecution } from "../lib/cli";
import { fromRoot } from "../lib/paths";
import {
  listContractEndpoints,
  loadOpenApiContract,
  type RouteEndpoint,
} from "../lib/openapi-contract";

const args = getCliArgs();
const jsonMode = args.has("--json");
const fixHint = args.has("--fix-hint");

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────
interface ParityReport {
  contract: RouteEndpoint[];
  nextjs: RouteEndpoint[];
  missingInNextjs: RouteEndpoint[];
  extraInNextjs: RouteEndpoint[];
}

// ─────────────────────────────────────────────────────────
// 1. Parse OpenAPI contract
// ─────────────────────────────────────────────────────────
function parseContract(): RouteEndpoint[] {
  try {
    return listContractEndpoints(loadOpenApiContract());
  } catch (error) {
    console.error(error instanceof Error ? `❌ ${error.message}` : `❌ ${String(error)}`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────
// 2. Parse Next.js routes (filesystem convention)
// ─────────────────────────────────────────────────────────
function parseNextjsRoutes(): RouteEndpoint[] {
  const apiDir = path.join(ROOT, "src", "app", "api");
  const endpoints: RouteEndpoint[] = [];

  function scanDir(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name === "route.ts" || entry.name === "route.js") {
        const relativePath = path
          .relative(apiDir, path.dirname(fullPath))
          .replace(/\\/g, "/");
        const routePath = `/api/${relativePath}`.replace(/\/+$/, "");

        const content = fs.readFileSync(fullPath, "utf-8");

        // Detect exported HTTP methods (exclude OPTIONS/HEAD — CORS preflight, not API endpoints)
        const exportedMethods = [
          "GET", "POST", "PUT", "DELETE", "PATCH",
        ];
        for (const method of exportedMethods) {
          // Match: export async function GET, export function GET, export { GET }
          const regex = new RegExp(
            `export\\s+(async\\s+)?function\\s+${method}\\b|export\\s*\\{[^}]*\\b${method}\\b`
          );
          if (regex.test(content)) {
            endpoints.push({ method, path: routePath });
          }
        }
      }
    }
  }

  scanDir(apiDir);
  return endpoints;
}

// ─────────────────────────────────────────────────────────
// Comparison logic
// ─────────────────────────────────────────────────────────
function normalizeEndpoint(e: RouteEndpoint): string {
  // Normalize path params to a generic placeholder so that naming differences
  // between backends don't cause false mismatches:
  //   - Next.js [param], [taskId], [workspaceId] → {p}
  //   - Contract {id}, {task_id}, {workspaceId} → {p}
  //   - Axum-style :id segments → {p}
  // Multi-segment params like /notes/{workspaceId}/{noteId} → /notes/{p}/{p}
  const normalizedPath = e.path
    .replace(/\[([^\]]+)\]/g, "{p}")      // Next.js [param] → {p}
    .replace(/\{[^}]+\}/g, "{p}")         // Any {param} → {p}
    .replace(/\/:[^/]+/g, "/{p}")         // Axum :param → {p}
    .replace(/\/+$/, "");                  // Remove trailing slashes
  return `${e.method} ${normalizedPath}`;
}

// Methods that are infrastructure/CORS only and should not be compared
const SKIP_METHODS = new Set(["OPTIONS", "HEAD"]);

function filterEndpoints(endpoints: RouteEndpoint[]): RouteEndpoint[] {
  return endpoints.filter((e) => !SKIP_METHODS.has(e.method.toUpperCase()));
}

function compareRoutes(
  contract: RouteEndpoint[],
  nextjs: RouteEndpoint[]
): ParityReport {
  // Strip CORS/infrastructure methods before comparison
  contract = filterEndpoints(contract);
  nextjs   = filterEndpoints(nextjs);

  const contractSet = new Set(contract.map(normalizeEndpoint));
  const nextjsSet = new Set(nextjs.map(normalizeEndpoint));

  const parseKey = (key: string): RouteEndpoint => {
    const [method, ...pathParts] = key.split(" ");
    return { method, path: pathParts.join(" ") };
  };

  // Missing in Next.js = in contract but not in Next.js
  const missingInNextjs = [...contractSet]
    .filter((k) => !nextjsSet.has(k))
    .map(parseKey);

  // Extra = in Next.js but not in contract
  const extraInNextjs = [...nextjsSet]
    .filter((k) => !contractSet.has(k))
    .map(parseKey);

  return {
    contract,
    nextjs,
    missingInNextjs,
    extraInNextjs,
  };
}

// ─────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────
function printReport(report: ParityReport) {
  const ok = "✅";
  const warn = "⚠️ ";
  const fail = "❌";

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║           Routa.js API Parity Report             ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  console.log(`📋 Contract defines:   ${report.contract.length} endpoints`);
  console.log(`🌐 Next.js implements: ${report.nextjs.length} endpoints`);
  console.log("");

  // Common endpoints
  const contractSet = new Set(report.contract.map(normalizeEndpoint));
  const nextjsSet = new Set(report.nextjs.map(normalizeEndpoint));
  const bothImplement = [...contractSet].filter(
    (k) => nextjsSet.has(k)
  );
  console.log(`${ok} Web backend implements: ${bothImplement.length}/${report.contract.length} contract endpoints\n`);

  if (report.missingInNextjs.length > 0) {
    console.log(`${fail} Missing in Next.js (${report.missingInNextjs.length}):`);
    for (const e of report.missingInNextjs) {
      console.log(`   ${e.method.padEnd(7)} ${e.path}`);
    }
    console.log("");
  }

  if (report.extraInNextjs.length > 0) {
    console.log(`${warn}Extra in Next.js (not in contract) (${report.extraInNextjs.length}):`);
    for (const e of report.extraInNextjs) {
      console.log(`   ${e.method.padEnd(7)} ${e.path}`);
    }
    console.log("");
  }

  if (fixHint && report.missingInNextjs.length > 0) {
    console.log("─── Fix Hints ───────────────────────────────────\n");

    console.log("Next.js: Create these route files:");
    for (const e of report.missingInNextjs) {
      const routeDir = e.path
        .replace(/^\/api/, "src/app/api")
        .replace(/\{(\w+)\}/g, "[$1]");
      console.log(`   ${routeDir}/route.ts → export async function ${e.method}()`);
    }
    console.log("");
  }

  // Summary
  // Extra routes in Next.js are printed above as warnings and included in the JSON
  // report, but the parity hard gate tracks contract coverage: every OpenAPI
  // endpoint must exist in the Web backend.
  const totalIssues = report.missingInNextjs.length;

  if (totalIssues === 0) {
    console.log(`${ok} All contract endpoints are implemented by the Web backend!\n`);
  } else {
    console.log(`── Summary: ${totalIssues} parity issue(s) found ──\n`);
  }

  return totalIssues;
}

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────
export function buildJsonSummary(report: ParityReport) {
  return {
    summary: {
      contractEndpoints: report.contract.length,
      nextjsEndpoints: report.nextjs.length,
      missingInNextjs: report.missingInNextjs.length,
      extraInNextjs: report.extraInNextjs.length,
    },
    missingInNextjs: report.missingInNextjs,
    extraInNextjs: report.extraInNextjs,
  };
}

function main() {
  const contract = parseContract();
  const nextjs = parseNextjsRoutes();
  const report = compareRoutes(contract, nextjs);

  if (jsonMode) {
    console.log(JSON.stringify(buildJsonSummary(report), null, 2));
    const totalIssues = report.missingInNextjs.length;
    process.exit(totalIssues > 0 ? 1 : 0);
  }

  const issues = printReport(report);
  process.exit(issues > 0 ? 1 : 0);
}

const ROOT = fromRoot();

if (isDirectExecution(import.meta.url)) {
  main();
}
