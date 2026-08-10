/**
 * Sessions & Skills API contract tests.
 *
 * Tests the /api/sessions and /api/skills endpoints.
 * These are read-only endpoints that should be safe to test.
 *
 * Note on `teamChainId` parity: this suite cannot create Team sessions
 * (session creation is not read-only), so field-level Web/Rust parity for
 * `teamChainId` on /api/sessions and /api/sessions/{id} is locked by unit
 * tests on both sides instead:
 * - Web: src/app/api/sessions/__tests__/route.test.ts and
 *   src/app/api/sessions/[sessionId]/__tests__/route.test.ts
 * - Rust: crates/routa-server/src/application/sessions.rs serializer tests
 * Legacy/omitted values are falsy on both backends and resolve to
 * `full_delivery` via the shared interpretation rules.
 */

import {
  api,
  assert,
  assertStatus,
  assertHasField,
  assertArrayField,
  type TestResult,
} from "./helpers";

export async function testSessions(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // ── GET /api/sessions — list sessions ──
  results.push(
    await runTest("GET /api/sessions — list sessions", async () => {
      const { status, data } = await api("GET", "/api/sessions");
      assertStatus(status, 200);
      const d = data as Record<string, unknown>;
      assertArrayField(d, "sessions");
    })
  );

  return results;
}

export async function testSkills(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // ── GET /api/skills — list skills ──
  results.push(
    await runTest("GET /api/skills — list skills", async () => {
      const { status, data } = await api("GET", "/api/skills");
      assertStatus(status, 200);
      const d = data as Record<string, unknown>;
      assertHasField(d, "skills");
      assert(Array.isArray(d.skills), "skills should be an array");
    })
  );

  // ── POST /api/skills — reload skills ──
  results.push(
    await runTest("POST /api/skills — reload skills", async () => {
      const { status, data } = await api("POST", "/api/skills");
      assertStatus(status, 200);
      const d = data as Record<string, unknown>;
      assert(d.reloaded === true, "Should return reloaded: true");
    })
  );

  return results;
}

async function runTest(
  name: string,
  fn: () => Promise<void>
): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (err) {
    return {
      name,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
    };
  }
}
