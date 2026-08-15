---
title: "Team Run cannot recover after its embedded runtime owner exits"
date: "2026-08-16"
status: resolved
severity: high
area: "team"
kind: issue
tags: ["team", "acp", "runtime", "recovery", "lease", "sqlite"]
reported_by: "user"
---

# Team Run stale-owner recovery

## Goal

Keep one path working end to end:

```text
open an existing Team Run
  -> recover or attach its Lead runtime
  -> connect the session stream
  -> deliver the first or next prompt exactly once
  -> show the Lead as active
```

The implementation should reuse the existing `resumeSession -> session/load ->
ensureSessionRuntime` path. Do not add another recovery service or Team-only protocol.

## Audit conclusion

The recovery change has one blocking prerequisite and one test-hygiene prerequisite that are
already fixed in the reference repository but are missing here:

1. **Blocking production fix:** `src/core/db/sqlite.ts` does not add
   `acp_sessions.team_chain_id`, although `src/core/db/sqlite-schema.ts` selects that column.
   Session reads and lease CAS then fail with `no such column: "team_chain_id"`; recovery fails
   closed as `recovery_unavailable` before it can evaluate ownership.
2. **Required test isolation:** `session-db-persister.test.ts` does not assign a per-test
   `ROUTA_DB_PATH`. Tests can share the repository-level `routa.db`, including stale lease rows.

Reference commits are `81c51856` (schema compatibility) and `eca8faec` (test isolation). Port only
the small TypeScript changes; do not cherry-pick either commit wholesale or restore Rust/Tauri code.

The stale-owner behavior itself is not a migration omission: the Team page, ACP client, and recovery
implementation are effectively identical in both repositories and contain the same defect.

## Confirmed failure

The reproduced Team Run was `f3acb59b-e96e-48e1-9a86-7efb1863669f`.

- Its durable owner was `next-81776`, but the live Next.js server PID was `30326`.
- `GET /api/acp?...&probe=1` returned `409` while the old lease was active.
- The browser stopped after four ownership-conflict retries, before the five-minute lease expired.
- After expiry, the probe called `refreshEmbeddedSessionLease`. That function retained the foreign
  `ownerInstanceId` and extended its lease, so the dead owner became live again in persistence.
- The Team page used `selectSession`, which only attached SSE. It did not call the existing explicit
  recovery entry `resumeSession`.
- The persisted transcript was empty, so the first prompt had never been accepted by the provider.
- The pending-prompt record expires after 30 seconds, much earlier than the default five-minute
  lease, so waiting for a legitimate takeover can discard the launch prompt.
- `BrowserAcpClient.prompt` creates a new `promptId` whenever the caller omits one. Re-running the
  Team first-prompt effect can therefore bypass durable deduplication.

## Preconditions

Complete these before changing recovery behavior.

### P0. Align the runtime SQLite schema

Relevant files:

- `src/core/db/sqlite.ts`
- `src/core/db/sqlite-schema.ts` (verification only)
- `drizzle-sqlite/0015_add_acp_session_team_chain_id.sql` (reference only)

Required change:

```ts
try { db.run(sql`ALTER TABLE acp_sessions ADD COLUMN team_chain_id TEXT`); } catch { /* already exists */ }
```

Rules:

- Keep the existing idempotent raw-DDL initialization pattern. Do not introduce a migration runner.
- The change must repair both legacy runtime databases and fresh databases created by the current
  initializer.
- Do not delete or rebuild a user's SQLite database.

### P1. Isolate the SQLite persister tests

Relevant file:

- `src/core/acp/__tests__/session-db-persister.test.ts`

Rules:

- Close the global SQLite handle before each test.
- Set `ROUTA_DB_PATH` to a database inside that test's temporary directory.
- Restore the previous environment value and close the handle after each test.
- This is test-only; do not change production database path selection.

## Required behavior

### Active local runtime

Use `selectSession` to attach SSE and continue normally. Do not call `resumeSession` and do not
recreate the provider runtime.

### Active foreign lease

Return a retryable ownership conflict. Keep the prompt in the composer and retry no earlier than
the lease hint. Never start a second provider runtime.

### Expired foreign lease

Do not refresh the foreign owner. Call `session/load`; `ensureSessionRuntime` must atomically acquire
the lease for the current instance, restore Team bindings, recover the provider, and then attach SSE.
`BrowserAcpClient.loadSession` already attaches SSE, so the page must not also call `selectSession`
for the same recovery attempt.

### Recovery failure

Show the existing localized recovery error and Retry action. Preserve the unsent prompt.

## Implementation boundary

Change only the Web Team/ACP recovery path.

### 1. Prevent foreign-owner renewal

Relevant files:

- `src/core/acp/session-lease.ts`
- `src/app/api/acp/route.ts`

Rules:

- `refreshEmbeddedSessionLease` may refresh only a lease owned by `getAcpInstanceId()`.
- A probe or SSE attach must not claim or refresh an expired foreign lease.
- Do not update the in-memory Session before the lease write is known to be valid.
- Ownership takeover remains exclusively in `ensureSessionRuntime`, using the existing database CAS.

### 2. Choose exactly one attach path

Relevant files:

- `src/app/workspace/[workspaceId]/team/[sessionId]/team-run-page-client.tsx`
- `src/client/hooks/use-acp.ts`

Rules:

- For `continuityStatus=active`, call `selectSession(sessionId)` only.
- For `restorable`, `interrupted`, or `stale`, call
  `resumeSession(sessionId, cwd, { throwOnError: true })` only. A successful load attaches SSE.
- Do not let an unconditional `selectSession` effect race with `resumeSession`.
- Use a page-context single-flight guard keyed by `workspaceId:sessionId` so rerenders cannot start
  concurrent Resume calls.
- Clear that guard when the route context changes or the attempt settles.

### 3. Honor the lease retry hint

Relevant file:

- `src/client/acp-client.ts`
- `src/app/workspace/[workspaceId]/team/[sessionId]/team-run-page-client.tsx`
- `src/client/hooks/use-acp.ts`

Rules:

- Do not treat four short retries as the end of a recoverable ownership conflict.
- Derive the next attempt from `leaseExpiresAt` or structured `retryAfterMs`; clamp the delay to a
  small positive minimum and add bounded jitter to avoid a tight synchronized loop.
- Cancel the timer when the page changes session or the ACP client disconnects.
- Retry must re-enter `session/load`, not merely probe SSE forever. SSE probing does not acquire a
  lease or restore a provider runtime.
- Keep response parsing/timing metadata in `BrowserAcpClient`; keep the Resume retry timer in the
  Team page bootstrap. Do not make the generic SSE client own Team recovery policy.

### 4. Preserve prompt delivery

Relevant files:

- `src/app/workspace/[workspaceId]/team/[sessionId]/team-run-page-client.tsx`
- `src/client/utils/pending-prompt.ts`
- existing pending-prompt helpers and tests

Rules:

- Do not clear either a text-only or attachment-bearing first prompt before backend acceptance.
- Add a stable `promptId` to `PendingPromptPayload` when the prompt is first stored. Pass that same
  ID through every recovery retry; never generate a new ID for the same pending delivery. Reuse the
  existing exported `generatePromptDeliveryId` helper.
- Preserve the same prompt identity, text, repository references, and attachment transfer ID across
  recovery retries.
- Do not expire a pending Team launch prompt while a retryable ownership conflict can still be
  waiting for the lease. Let the peek/read helper accept a maximum age and have the Team page use a
  simple ten-minute window; preserve the existing 30-second default for other surfaces.
- Clear it only after the backend accepts delivery.
- A retry must not execute the prompt twice.

## Non-goals

- No new endpoint; use `/api/acp` `session/load`.
- No new lease table or distributed lock system.
- No provider-specific recovery branch in the Team page.
- No redesign of Team UI, roster, task tree, transcript, or deletion.
- No Rust/Desktop parity work; this repository is Web-only.
- No change to the default 300-second lease duration as the primary fix.
- No broad refactor of `useAcp`, `BrowserAcpClient`, or the ACP route.
- No redesign of the general pending-prompt system beyond carrying a stable delivery ID and allowing
  the Team recovery window.
- No fix for the separate Notes SQLite upsert defect or unrelated API-contract coverage gaps.

## Required regression tests

Keep tests focused on the main chain:

1. A temporary runtime SQLite database can save and load an ACP Session containing
   `teamChainId`, and lease acquisition does not return `unavailable` because of schema drift.
2. Session DB persister tests use separate SQLite files and cannot observe another test's lease row.
3. An expired foreign Session passed through an ACP probe does not receive a renewed foreign lease.
4. An active Team Lead selects/attaches without calling `session/load`.
5. A restorable Team Lead calls `session/load`; the page does not also call `selectSession`.
6. An active foreign lease returns a retryable conflict without creating a second runtime.
7. After lease expiry, exactly one contender acquires the lease with the current instance ID.
8. A first prompt remains available beyond 30 seconds while recovery is retryable.
9. Recovery retries reuse one `promptId`; after Resume, the backend accepts and dispatches that
   delivery once.

Prefer extending these existing suites:

- `src/app/api/acp/__tests__/route.test.ts`
- `src/core/acp/__tests__/session-runtime-recovery.test.ts`
- `src/core/acp/__tests__/session-db-persister.test.ts`
- `src/client/__tests__/acp-client.test.ts`
- `src/client/__tests__/pending-prompt.test.ts`
- `src/app/workspace/[workspaceId]/team/[sessionId]/__tests__/team-run-page-client.test.tsx`

## Acceptance criteria

- Restarting Next.js while a Team Run exists no longer leaves the page permanently suspended.
- Fresh and legacy SQLite databases both expose `acp_sessions.team_chain_id`; Session load and lease
  acquisition do not fail with schema-unavailable errors.
- Opening the Team Run does not extend the lease of a dead instance.
- The current instance takes over only after the foreign lease expires.
- The Team Lead reaches `active`, SSE connects, and a prompt produces transcript output.
- During recovery, the UI keeps the prompt and exposes a retryable error instead of silently losing it.
- The stored prompt survives the lease wait and keeps one stable `promptId` until acceptance.
- Resume and select/attach are mutually exclusive for one page bootstrap attempt.
- Existing active sessions still attach without provider recreation.
- Focused tests pass, followed by the repository fast fitness gate.

## Implementation order

1. Port the `team_chain_id` raw-DDL compatibility fix and verify it with a temporary SQLite DB.
2. Port per-test `ROUTA_DB_PATH` isolation and run `session-db-persister.test.ts`.
3. Add a failing probe/lease regression test, then restrict lease refresh to the current owner.
4. Add failing active-vs-restorable Team bootstrap tests.
5. Make the Team page choose either `selectSession` or `resumeSession`, never both.
6. Make ownership retry honor the lease hint and re-enter `session/load` after the wait.
7. Store and reuse one pending-prompt `promptId`; retain the prompt throughout the lease wait and
   clear it only after acceptance.
8. Run the focused suites above, then
   `npm run fitness:run -- --tier fast --scope local --min-score 0`.

Stop after this chain is green. Do not bundle Notes, contract-coverage, UI redesign, or general ACP
refactoring into the same change.

## Resolution

Resolved on 2026-08-16 by restoring the existing `session/load` recovery path for restorable Team
Leads, preventing probes from renewing foreign leases, and retaining one stable pending-prompt
delivery ID until backend acceptance. The runtime SQLite initializer now also repairs the missing
`team_chain_id` column, and the persister tests use isolated temporary databases.

Verification:

- Focused Vitest suites: 6 files passed, 91 tests passed.
- Fast fitness: all non-code-quality dimensions passed in the aggregate run.
- Code-quality fast fitness rerun with dependency access: 6/6 metrics passed, score 100, no hard
  gate failure.

## Reference

The intended recovery contract already exists in
`/Users/xie/Documents/vibecoding/Loom-v2/routa/docs/design-docs/team-session-runtime-recovery.md`.
Use it for semantics, but do not copy the corresponding Web files wholesale: their current lease
refresh and Team-page wiring are effectively identical to this repository and retain this defect.
