---
title: "Team sessions retain history but cannot resume after the provider runtime exits"
date: "2026-08-11"
status: resolved
severity: high
area: "team"
kind: issue
tags: ["team", "session", "runtime", "recovery", "acp"]
reported_by: "user"
---

# Team sessions retain history but cannot resume after the provider runtime exits

## What happened

A Team Lead session remained visible with its transcript, task tree, and members after the
Next.js instance and embedded Claude process that owned it had exited. Sending a follow-up prompt
did not resume the Lead. The backend rejected the request because the embedded ownership lease
belonged to an expired instance, while the client cleared the composer and suppressed the error.

The reproduced Team Run was `a9f6001e-51f1-4f5d-974e-ff3af62eee91`. Its durable record retained the
Routa session and Agent identity, but `provider_session_id` was empty, so native Claude resume was
not possible.

## Why it matters

Team is presented as a durable coordination surface. A process restart must not turn an existing
Team into a read-only transcript while it still appears to be working. Keeping every provider
process alive indefinitely is also not acceptable because a Team may create many child sessions.

## Expected behavior

- Team, Agent, and Routa Session identities remain stable across runtime restarts.
- Provider runtimes may be released when idle or complete.
- A new backend instance safely takes over an expired embedded lease.
- Recovery uses the provider-native session when available and a bounded context rebuild otherwise.
- Team Lead role, specialist, MCP profile, child-session links, and unfinished work are restored.
- The UI reports `suspended`, `recovering`, or `failed` instead of displaying a dead session as
  `working`.

## Design

The implemented design is documented in
[Team Session Runtime Lifecycle and Recovery](../design-docs/team-session-runtime-recovery.md).

## Root cause (confirmed)

1. **Lost provider continuity**: `provider_session_id` was never captured/persisted for embedded
   Claude sessions, so after a restart there was nothing to resume natively. The Routa Session ID
   was the only durable identity, and it is not a provider conversation ID by design.
2. **Expired ownership lease**: the embedded execution lease belonged to the dead instance and no
   compare-and-swap takeover existed, so the new instance refused to run the session.
3. **Silent client failure**: prompt failures surfaced as a cleared composer instead of a visible,
   retryable error state.
4. **No unified recovery entry**: user messages, explicit Resume, and sub-Agent reports each had
   their own dispatch paths; only some of them recovered a suspended runtime.

## Resolution summary

- **Identity separation enforced end to end**: Routa Session ID and logical Agent ID stay durable;
  the provider-native session ID is stored ONLY in `provider_session_id` and is never written to
  `routa_agent_id` (regression-locked by unit tests on both backends).
- **Unified recovery entry**: every prompt path (user message, Resume, child completion report)
  flows through `ensureSessionRuntime` with a provider recovery adapter: native resume when
  `provider_session_id` exists, bounded context rebuild otherwise, structured `session_not_found`
  style errors when recovery is impossible. Context rebuild is provider-neutral: one recovery
  envelope (`src/core/acp/recovery-context.ts`, schema `routa.recovery-envelope@1`) is injected
  exactly once through a supported channel (Claude CLI `--append-system-prompt`, Claude SDK
  `systemPromptAppend`, otherwise a clearly-marked first-prompt prefix) — no full chunk replay, no
  forged second user message, and nothing is injected when native resume succeeds.
- **Lease takeover**: atomic `tryAcquireExpiredLease` compare-and-swap lets a new instance adopt an
  expired embedded lease; lease refresh keeps an active owner authoritative.
- **Durable delivery**: child completion reports carry a deterministic delivery ID
  (`team-report:<parent>:<child>:<task>:<revision>`) with a `:delivered` receipt appended only
  after the provider accepts the report prompt — at-least-once delivery, idempotent append.
- **Safe release policy (Phase 3)**: a completed child runtime is released only when every gate
  passes (feature flag, not a ROUTA Lead, not streaming, no pending interaction, no active
  descendants, recovery-ready, durable report receipt, history/trace persisted before kill).
  Any failed gate retains the runtime with an explicit skip reason
  (`auto-release-disabled | streaming | pending-interaction | report-not-delivered |
  history-not-durable | active-dependency | recovery-not-ready`).
- **Dependency semantics fixed**: an active parent record no longer pins a completed child
  process; only active descendants block release.
- **UI continuity**: `continuityStatus` (`active | interrupted | restorable | stale`) is derived on
  read in both backends; Team lanes show `suspended/recovering/failed` via i18n and a retryable
  prompt-failure banner.
- **Lease fail-closed (acceptance round 2)**: lease acquisition returns a structured five-state
  result (`acquired | already_owned | conflict | missing | unavailable`); any database failure
  yields `unavailable` and recovery refuses to start a runtime (retryable
  `recovery_unavailable -32011`). `missing` only arises from a successful query that found no row.
  The dispatch heartbeat stops prompt delivery when the lease is lost (isolating the runtime) or
  cannot be verified (fail-closed without killing it).
- **Team bindings all-or-nothing (acceptance round 2)**: ROUTA Lead restoration must rebuild every
  binding (Lead Agent mapping, child Session mappings, child records, notification handler,
  child-session-registration handler, Team MCP profile) or recovery fails with a structured
  `-32012` error (`failure: missing_team_metadata | team_bindings_incomplete`) before any runtime
  is started — never a silent chat-only degradation. The UI keeps history and input and shows a
  localized error. Rust mirrors the same structured contract.

## Acceptance round-2 fixes (2026-08-11)

The round-1 implementation passed its own tests, but independent acceptance rejected several
real-execution-path defects (three P0, two P1). Each fix followed the mandated RED→GREEN cycle: a
failing regression test first, then the minimal code change. No commit has been made; all changes
remain in the uncommitted worktree.

### P0-1: Claude provider session ID only from `system/init`

- **Root cause**: `createClaudeSession` resolves with the Routa Session ID (the Claude CLI has no
  `session/new` step) and the SDK adapter resolves with a synthetic runtime handle. Recovery
  persisted those handles into `provider_session_id`, polluting the only field that may carry a
  native resume ID.
- **Fix**: `provider_session_id` is written only from the provider's own report — the Claude
  `system/init` capture hook (and the equivalent provider-reported IDs). Runtime handles are never
  persisted there; the finalizer treats a polluted/absent ID as absent.
- **Tests** (`session-runtime-recovery.test.ts`): "does not persist the Routa Session ID returned
  by createClaudeSession as providerSessionId", "persists the Claude native ID only after the
  system/init capture hook fires", "keeps the prior native ID on seeded Claude native resume until
  a new system/init arrives".

### P0-2: structured `appendHistoryOnce` results

- **Root cause**: boolean append results conflated "true duplicate" with "persistence failure", so
  a transient DB failure could be acked as a duplicate (dropping the prompt) or accepted without
  durable record.
- **Fix**: structured results distinguish a true `duplicate` (same event durably exists),
  `promptAccepted`, and persistence failure; a persistence failure never reports
  `promptAccepted=true`, never clears the composer, and never dispatches.
- **Tests** (`prompt-delivery.test.ts`): including "reports duplicate when the append race is lost
  to a concurrent writer", "fails closed when durable persistence is unavailable (never reports
  duplicate)", "reports session_not_found for unknown sessions instead of a duplicate ack".

### P0-3: bounded context rebuild via a provider-neutral envelope

- **Root cause**: context rebuild was claimed complete without an envelope or tests locking "no
  chunk replay / no forged user message / inject exactly once".
- **Fix**: `recovery-context.ts` builds and renders a bounded envelope
  (`routa.recovery-envelope@1`): a clearly-marked internal block labeled NOT a user message, capped
  selections that count dropped entries, deterministic ordering. Injection channels: Claude CLI
  `--append-system-prompt`, Claude SDK `systemPromptAppend`, otherwise a one-shot pending prefix
  consumed by `session-prompt`. Native resume success injects nothing.
- **Tests** (`recovery-context.test.ts`): envelope bounds/determinism, internal-block marker,
  one-shot pending channel, Team Lead vs non-Team collection.

### P1-1: lease fail-closed (5-state acquisition + checked dispatch heartbeat)

- **Root cause**: lease acquisition was boolean; a DB exception was indistinguishable from "row
  missing", so a storage outage could masquerade as a recoverable state and start a runtime whose
  ownership was never verified.
- **Fix**: `acquireSessionLeaseInDb` returns `acquired | already_owned | conflict | missing |
  unavailable`; any DB error maps to `unavailable` and recovery throws retryable
  `recovery_unavailable` (-32011) without starting a runtime. `missing` is reported only when a
  successful query finds no durable row (JSONL-only sessions). The boolean facade is retained only
  for fire-and-forget refresh callers (attach/SSE). The checked dispatch heartbeat
  (`checkEmbeddedSessionLeaseForDispatch`) returns `owned | no_record | lost | unavailable`:
  `lost` stops dispatch and isolates the runtime via `manager.killSession`; `unavailable` stops
  dispatch fail-closed WITHOUT killing the runtime.
- **Tests**: `session-db-persister.test.ts` describe "acquireSessionLeaseInDb (P1 fail-closed
  5-state result)" (7 cases, including expired-lease takeover and never preempting an active
  foreign lease); `session-prompt.test.ts` describe "embedded lease heartbeat gating (P1
  fail-closed)"; recovery branching in `session-runtime-recovery.test.ts`.

### P1-2: Team binding restoration is all-or-nothing

- **Root cause**: `restoreTeamRuntimeBindings` was best-effort: a missing Lead `routaAgentId`, a
  dead session store, an unmappable descendant, or a failed handler installation was swallowed (or
  partially registered), and recovery then started a chat-only runtime — a silent degradation of a
  Team Lead into plain chat.
- **Fix**: restoration is all-or-nothing and validates BEFORE mutating, covering the Lead Agent
  mapping, child Session mappings, child records, notification handler, child-session-registration
  handler, and Team MCP profile. Any failure returns a structured `TeamBindingFailure`
  (`missing_team_metadata` → non-retryable; `team_bindings_incomplete` → retryable; with
  `missingMetadata` / `missingBindings` / `unmappedSessionIds`) and recovery throws
  `-32012 recovery_failed` BEFORE starting any runtime. Attached live runtimes are exempt (their
  bindings were installed in-process at creation). The Team composer maps structured failures to
  localized messages via `resolveTeamPromptErrorI18nKey` and keeps history and input
  (`failedTimelinePrompt` + Retry). Rust parity: `restore_routa_coordinator_binding` propagates
  failure; the `session/load` call site kills the fresh runtime and returns
  `team_bindings_failed_response` — same code `-32012`, `data.reason=recovery_failed`,
  `data.failure=team_bindings_incomplete`, `retryable=true`. (Rust auto-creates a missing routa
  agent rather than failing on missing metadata; the parity contract is that binding-restoration
  failure is never silent.)
- **Tests**: `team-runtime-bindings.test.ts` (all-or-nothing describe: missing metadata, store
  offline, orphan descendant without `routa_agent_id`, handler installation failure — each asserts
  no partial registration occurred); `session-recovery-errors.test.ts`
  (`buildTeamBindingsFailedError` shape for both failure codes); `session-runtime-recovery.test.ts`
  (bindings failure → -32012 with no runtime created; missing metadata non-retryable; non-ROUTA
  skips restoration; attach survives a failed refresh; bindings restore before runtime start and
  carry the Team MCP profile); `team-run-page-model.test.ts` (`resolveTeamPromptErrorI18nKey`
  mapping incl. null fallbacks); Rust `team_bindings_failure_matches_web_recovery_contract`.

### Documentation corrections (acceptance feedback)

- **Context rebuild**: round 1 claimed a bounded context rebuild without pointing at an envelope or
  tests; the envelope and its regression tests now exist (P0-3 above). "Rebuild complete" means the
  envelope + injection channels are test-locked, not merely described.
- **Rust runtime ownership**: the desktop backend DOES hold provider runtimes —
  `AppState.acp_manager` (`routa_core::acp::AcpManager`) owns the `AcpProcess` handles, and
  recovery kills/recreates sessions through that manager (see `session/load` in
  `crates/routa-server/src/api/acp_routes.rs`). Any earlier text implying the Rust side is a
  runtime-less owner was wrong.
- **Three-ID evidence**: the evidence of record for ID separation is NON-MOCK: Rust storage
  round-trip `test_provider_session_id_round_trips_separately_from_routa_agent_id` (real SQLite
  store) and Web `sqlite-acp-session-retention.test.ts` (real migrated SQLite DB). Mocked
  recovery-flow unit tests are supplementary behavior locks, not the primary evidence.
- **DB-failure behavior**: lease verification failure blocks runtime start (P1-1
  `unavailable` → retryable `recovery_unavailable`, no runtime) AND blocks prompt delivery
  (dispatch heartbeat `unavailable` → fail-closed stop without kill; `lost` → stop + isolate).

## Validation evidence (2026-08-11)

- TypeScript full suite: `Test Files 408 passed | 1 skipped (409)`, `Tests 2668 passed |
  23 skipped (2691)` (+17 new tests over the pre-change baseline of 2651).
- Rust baselines: `cargo test -p routa-core storage::` → 18 passed (includes
  `test_provider_session_id_round_trips_separately_from_routa_agent_id`);
  `cargo test -p routa-server --lib acp_routes` → 22 passed.
- `entrix run --dry-run` → PASS (100%).
- `entrix run --tier fast` → FINAL SCORE 100.0% PASS (all hard gates green, including
  eslint/typecheck/clippy/ts tests; see "Known infra errors" below).
- `entrix run --tier normal` → FINAL SCORE 91.7% PASS. All hard gates green:
  `api_contract_parity`, `rust_api_test`, `npm_audit_critical`, `cargo_audit`,
  `npm_audit_high`, `ts_test_pass`, `ts_test_pass_full`, `rust_test_pass`.
  Soft failure: `ts_test_coverage` — repo-wide line coverage 62.4% vs the 80% target, a
  pre-existing aggregate state of the codebase (large uncovered UI surfaces), not caused by this
  change: every module this work added or reworked is well covered (completed-child-release 100%,
  sqlite-acp-session-history 100%, session-lease 100%, team-report-delivery 97.4%,
  prompt-delivery 95.7%, session-recovery-errors 92.3%, session-runtime-finalizer 92.7%,
  session-continuity 90%, forwarded-notification 86.7%, session-runtime-recovery 78.2%).
- `git diff --check` → clean.

### Round-2 evidence (acceptance fixes, 2026-08-11)

- TypeScript full suite: `Test Files 409 passed | 1 skipped (410)`, `Tests 2735 passed |
  23 skipped (2758)` (+13 regression tests over the round-1 baseline of 2722).
- Rust: `cargo test -p routa-server --lib acp_routes` → 23 passed, including
  `team_bindings_failure_matches_web_recovery_contract` (asserts the Rust
  `team_bindings_failed_response` shape equals the Web `buildTeamBindingsFailedError` contract:
  code -32012, reason `recovery_failed`, failure `team_bindings_incomplete`, retryable true).
- Three-ID separation, non-mock evidence of record:
  - Rust `cargo test -p routa-core storage::` includes
    `test_provider_session_id_round_trips_separately_from_routa_agent_id` against the real SQLite
    store;
  - Web `src/core/db/__tests__/sqlite-acp-session-retention.test.ts` against a real migrated
    SQLite DB: "round-trips providerSessionId separately from routaAgentId and never backfills
    it" and "updates only provider_session_id via setProviderSessionId, preserving routa_agent_id
    and history".
  Mocked recovery-flow unit tests additionally lock the behavior but are not the primary evidence.
- `npx tsc --noEmit` → clean. `git diff --check` → clean.
  `python3 .github/scripts/issue-scanner.py --check` → exit 0.
- `entrix run --dry-run` → PASS (100%). `entrix run --tier fast` → FINAL SCORE 96.1% PASS.
  `entrix run --tier normal` → FINAL SCORE 90.1% PASS; all HARD gates green
  (`api_contract_parity`, `rust_api_test`, `ts_test_pass`, `ts_test_pass_full`, `rust_test_pass`,
  `cargo_audit`, `npm_audit_critical`, `npm_audit_high`). The `ts_test_coverage` soft gate remains
  the pre-existing repo-wide aggregate (~62% vs the 80% target); the INFRA ERRORS list
  (`legacy_hotspot_budget_guard`, `file_line_limit`, plus pre-existing desktop-shell/startup
  probes) is unchanged frozen baseline, not caused by this work.

## Known limitations and follow-ups

- **Group-wake release**: when several children complete together, only the LAST completer's
  completion triggers the parent wake, so only that child's receipt is persisted immediately; its
  runtime is auto-released. Earlier group members keep their runtime until a later lifecycle
  trigger (next completion/disconnect/shutdown) or stale cleanup (1h threshold).
- **Lead idle TTL disabled in version one**: ROUTA Lead sessions are never auto-released on
  completion (`auto-release-disabled`); they are reclaimed only by explicit disconnect/delete or
  team-run deletion. An idle-Lead TTL is a separate follow-up after recovery metrics exist.
- **At-least-once boundary**: report delivery may re-dispatch after a crash until the receipt is
  durable; the deterministic delivery ID plus idempotent append make duplicates safe.
- **Skipped completed releases**: a child whose release was skipped (e.g. transient persistence
  failure) is reconsidered on the next completion/disconnect/shutdown trigger. It is not evicted by
  memory cleanup while its parent record exists, because `collectEvictableSessionIds` protects
  child records of live parents to avoid orphaning in-flight sessions.
- **Pre-existing infra error**: `legacy_hotspot_budget_guard`/`file_line_limit` report
  `crates/routa-server/src/api/acp_routes.rs` against a stale 873-line override even at HEAD
  (2399 lines); the reason text marks it "pending API route split". This change reduced the file
  from 2463 to 2351 lines (below the HEAD baseline) and moved recovery helpers into
  `crates/routa-server/src/api/acp_routes/session_recovery.rs`.
- **Incidental fix (unrelated crate)**: `--tier normal` initially failed the `rust_test_pass`
  hard gate on `trace_parser::transcript_discovery::filters_roots_by_client_name`. That test
  asserted roots discovered from the REAL `$HOME` (no temp-home override for the `auggie`/`all`
  cases), so it failed on machines without `~/.qoder/projects`. The crate had zero diff from
  this work; the test was fixed to route all cases through its temp home
  (`crates/trace-parser/src/transcript_discovery.rs`, test-only change, 14/14 pass).

## Relevant files

- `src/core/acp/execution-backend.ts`
- `src/core/acp/session-prompt.ts`
- `src/core/acp/session-runtime-finalizer.ts`
- `src/core/acp/session-runtime-recovery.ts`
- `src/core/acp/session-recovery-errors.ts`
- `src/core/acp/recovery-context.ts`
- `src/core/acp/prompt-delivery.ts`
- `src/core/acp/session-db-persister.ts`
- `src/core/acp/session-lease.ts`
- `src/core/acp/claude-code-process.ts`
- `src/core/acp/claude-code-sdk-adapter.ts`
- `src/core/acp/acp-process-manager.ts`
- `src/core/acp/http-session-store.ts`
- `src/core/orchestration/orchestrator.ts`
- `src/core/orchestration/team-runtime-bindings.ts`
- `src/core/orchestration/team-report-delivery.ts`
- `src/core/orchestration/completed-child-release.ts`
- `src/core/db/sqlite-stores.ts`, `src/core/db/sqlite-acp-session-history.ts`
- `src/app/workspace/[workspaceId]/team/[sessionId]/team-run-page-client.tsx`
- `src/app/workspace/[workspaceId]/team/[sessionId]/team-run-page-model.ts`
- `src/client/hooks/use-acp.ts`
- `crates/routa-core/src/storage/local_session_provider.rs`
- `crates/routa-server/src/api/acp_routes.rs` (+ `acp_routes/session_recovery.rs`)
