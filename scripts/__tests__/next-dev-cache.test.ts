import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCacheReport,
  CACHE_WARNING_THRESHOLD_BYTES,
  cleanNextCache,
  findRepoRoot,
  formatBytes,
  parsePsOutputForDevServers,
  probeLocalNextServer,
  resolveNextCacheDir,
  resolveProbePorts,
} from "../dev/next-dev-cache.mjs";

interface CleanupFixture {
  root: string;
}

function createRepoFixture(): CleanupFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "routa-next-cache-test-"));

  // Generated cache that clean is allowed to remove.
  mkdirSync(path.join(root, ".next", "dev", "cache", "turbopack"), { recursive: true });
  writeFileSync(path.join(root, ".next", "dev", "cache", "turbopack", "cache-blob"), "x".repeat(4096));
  mkdirSync(path.join(root, ".next", "cache", "webpack"), { recursive: true });
  writeFileSync(path.join(root, ".next", "cache", "webpack", "pack"), "y".repeat(1024));

  // Durable state that clean must never touch.
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "page.tsx"), "export default function Page() { return null; }");
  mkdirSync(path.join(root, ".routa"), { recursive: true });
  writeFileSync(path.join(root, ".routa", "routa.sqlite"), "sqlite-placeholder");
  mkdirSync(path.join(root, "worktrees", "feature-a"), { recursive: true });
  writeFileSync(path.join(root, "worktrees", "feature-a", "notes.md"), "worktree content");

  return { root };
}

describe("next-dev-cache", () => {
  let fixture: CleanupFixture;

  beforeEach(() => {
    fixture = createRepoFixture();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  describe("findRepoRoot", () => {
    it("resolves two levels above scripts/dev", () => {
      expect(findRepoRoot(path.join(fixture.root, "scripts", "dev"))).toBe(fixture.root);
    });
  });

  describe("resolveNextCacheDir", () => {
    it("targets only <repoRoot>/.next", () => {
      expect(resolveNextCacheDir(fixture.root)).toBe(path.join(fixture.root, ".next"));
    });

    it("refuses a symlinked .next directory", () => {
      rmSync(path.join(fixture.root, ".next"), { recursive: true, force: true });
      const outside = mkdtempSync(path.join(os.tmpdir(), "routa-outside-"));
      symlinkSync(outside, path.join(fixture.root, ".next"));

      expect(() => resolveNextCacheDir(fixture.root)).toThrow(/symlink/i);
      rmSync(outside, { recursive: true, force: true });
    });
  });

  describe("parsePsOutputForDevServers", () => {
    it("matches next dev, next-server, and next start processes", () => {
      const output = [
        "node /repo/node_modules/.bin/next dev --webpack",
        "next-server (v16.2.12)",
        "node /repo/node_modules/.bin/next start",
      ].join("\n");

      expect(parsePsOutputForDevServers(output)).toHaveLength(3);
    });

    it("does not match builds, this helper, or unrelated processes", () => {
      const output = [
        "node /repo/node_modules/.bin/next build",
        "node scripts/dev/next-dev-cache.mjs clean",
        "npm run dev",
        "node server.js",
        "vitest run scripts/__tests__",
      ].join("\n");

      expect(parsePsOutputForDevServers(output)).toHaveLength(0);
    });
  });

  describe("resolveProbePorts", () => {
    it("defaults to port 3000", () => {
      expect(resolveProbePorts({})).toEqual([3000]);
    });

    it("adds a numeric PORT env value and ignores non-numeric ones", () => {
      expect(resolveProbePorts({ PORT: "4100" })).toEqual([3000, 4100]);
      expect(resolveProbePorts({ PORT: "not-a-port" })).toEqual([3000]);
    });
  });

  describe("probeLocalNextServer", () => {
    it("detects a server that advertises Next.js", async () => {
      const fetchImpl = vi.fn(async () => ({
        headers: { get: (name: string) => (name.toLowerCase() === "x-powered-by" ? "Next.js" : null) },
      }));

      const probe = await probeLocalNextServer(3000, fetchImpl as never);
      expect(probe).toMatchObject({ source: "http", port: 3000 });
    });

    it("returns null when the connection fails", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      });

      await expect(probeLocalNextServer(3000, fetchImpl as never)).resolves.toBeNull();
    });
  });

  describe("buildCacheReport", () => {
    it("reports cache sizes and flags threshold breaches", () => {
      const report = buildCacheReport(fixture.root, { thresholdBytes: 1024 });
      expect(report.exists).toBe(true);
      expect(report.totalBytes).toBeGreaterThan(4096);
      expect(report.turbopackBytes).toBe(4096);
      expect(report.overThreshold).toBe(true);

      const healthy = buildCacheReport(fixture.root, { thresholdBytes: CACHE_WARNING_THRESHOLD_BYTES });
      expect(healthy.overThreshold).toBe(false);
    });
  });

  describe("cleanNextCache", () => {
    it("refuses with details while a dev server is running and keeps the cache intact", async () => {
      const detect = vi.fn(async () => [
        { source: "http", port: 3000, detail: "Next.js server responding on http://127.0.0.1:3000/" },
      ]);

      const result = await cleanNextCache({ repoRoot: fixture.root, detect });

      expect(result.refused).toBe(true);
      expect(result.cleaned).toBe(false);
      expect(result.message).toMatch(/Stop the dev server first/);
      expect(existsSync(path.join(fixture.root, ".next"))).toBe(true);
    });

    it("removes only .next after the server stops, leaving source, database, and worktrees intact", async () => {
      const detect = vi.fn(async () => []);

      const result = await cleanNextCache({ repoRoot: fixture.root, detect });

      expect(result.cleaned).toBe(true);
      expect(existsSync(path.join(fixture.root, ".next"))).toBe(false);
      expect(readFileSync(path.join(fixture.root, "src", "page.tsx"), "utf8")).toContain("export default");
      expect(existsSync(path.join(fixture.root, ".routa", "routa.sqlite"))).toBe(true);
      expect(existsSync(path.join(fixture.root, "worktrees", "feature-a", "notes.md"))).toBe(true);
    });

    it("skips cleanly when there is no generated cache", async () => {
      rmSync(path.join(fixture.root, ".next"), { recursive: true, force: true });
      const detect = vi.fn(async () => []);

      const result = await cleanNextCache({ repoRoot: fixture.root, detect });

      expect(result).toMatchObject({ cleaned: false, skipped: true });
      expect(detect).not.toHaveBeenCalled();
    });
  });

  describe("formatBytes", () => {
    it("renders GiB/MiB/KiB units", () => {
      expect(formatBytes(3 * 1024 ** 3)).toBe("3.00 GiB");
      expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MiB");
      expect(formatBytes(2048)).toBe("2.0 KiB");
      expect(formatBytes(512)).toBe("512 B");
    });
  });
});
