---
title: "Team Run deletion preserves explicitly owned Kanban cards"
date: "2026-08-11"
kind: issue
status: resolved
severity: high
area: team-kanban
tags: [team, kanban, deletion, ownership, sessions]
reported_by: "User"
related_issues: []
github_issue: null
github_state: null
github_url: null
---

# Team Run deletion preserves explicitly owned Kanban cards

## What Happened

Deleting a Team Run removes its root Session, but Kanban cards created by that
Team can remain on the board. The surviving cards may still carry the deleted
root Session ID in `task.teamRunId` and retain lane automation Session IDs in
`triggerSessionId`, `sessionIds`, or `laneSessions`.

Once the root Session has been deleted, retrying the same Team deletion is not
possible because the endpoint correctly returns `TEAM_RUN_NOT_FOUND`.

## Expected Behavior

- A card whose `teamRunId` equals the deleted Team Run root ID is deleted with
  that Team Run.
- A card explicitly owned by another Team Run is never deleted.
- A legacy card without `teamRunId` is deleted only when its Session linkage
  proves that it belongs exclusively to the deleted Team tree.
- Shared worktrees, Agents, and other resources continue to use their existing
  survivor-first protection.
- Deleting one Team Run never deletes a workspace, codebase, board, repository,
  Git branch, or card owned by another Team Run.

## Reproduction Context

- Environment: Next.js web/local runtime with persistent SQLite; the same
  planning semantics also affect Postgres.
- Trigger:
  1. Start a Team Run.
  2. Let the Team create cards and run lane automation Sessions.
  3. Delete the Team Run.
  4. Return to the Kanban board and observe that Team-owned cards remain.

## Confirmed Root Cause

`buildPlanFromSessions` correctly recognizes explicit ownership using
`task.teamRunId === root.sessionId`. It then applies `hasExternalLiveRef` to
both explicitly owned and legacy-inferred cards. Any live Session ID referenced
by the card but absent from the Team's `parentSessionId` tree moves the card to
`sharedKanbanTaskIds`, excluding it from persistent deletion.

Kanban lane Sessions are created through `triggerAssignedTaskAgent` without a
Team root `parentSessionId`. They therefore appear outside the Team tree even
when they were created to execute a Team-owned card.

The guard also overstates the relationship it proves: `collectTaskSessionRefs`
collects card-to-Session execution-history fields. It does not prove that an
outside Session owns or depends on the card. Explicit card ownership is
therefore being overridden by a weaker, reverse-direction inference.

The regression was introduced by commit `3ea1dd39` (`feat(team): delete
explicitly owned team cards`). That change added explicit ownership matching
but deliberately retained shared-Session preservation after the match. Its
tests cover a synthetic `outsider-1` Session, but not a Team-owned card whose
normal lane Session is live and lacks `parentSessionId`.

## Relevant Files

- `src/core/orchestration/team-run-deletion.ts`
- `src/core/orchestration/team-run-identity.ts`
- `src/core/kanban/workflow-orchestrator-singleton.ts`
- `src/core/kanban/agent-trigger.ts`
- `src/core/orchestration/__tests__/team-run-deletion.test.ts`
- `src/app/api/team-runs/[rootSessionId]/route.ts`
- `src/app/api/team-runs/[rootSessionId]/preview/route.ts`
- `src/app/api/team-runs/team-run-deletion-ports.ts`

## Resolution Direction

Make explicit ownership authoritative for cards:

- `task.teamRunId === root.sessionId` -> delete.
- non-empty `task.teamRunId !== root.sessionId` -> preserve.
- missing `task.teamRunId` -> retain the current conservative legacy inference,
  including outside-live-Session protection.

Do not attach lane Sessions to the Team tree merely to make deletion work. That
would change Session hierarchy, lifecycle, and UI semantics to compensate for
an ownership-planning bug.

Historical orphaned cards require a separate workspace-scoped preview and
cleanup path because their Team Run root no longer exists.

## Resolution

Implemented on 2026-08-11. Explicit `teamRunId` ownership is now authoritative
for kanban cards; session execution history can no longer override it.

### What changed

`src/core/orchestration/team-run-deletion.ts` — `buildPlanFromSessions` now
splits card classification into two mutually exclusive branches that match the
ownership matrix in the design doc:

- `task.teamRunId === root.sessionId` → deleted. Recorded in both
  `kanbanTaskIds` and `explicitKanbanTaskIds`, unconditionally. The previous
  `hasExternalLiveRef` escape hatch no longer applies to explicitly owned
  cards, so a live lane session without a Team `parentSessionId` can no longer
  move the card into `sharedKanbanTaskIds`.
- Non-empty `task.teamRunId !== root.sessionId` → preserved. Never deleted even
  when the card references this tree's sessions.
- Missing `teamRunId` → legacy inference only: deleted when session refs
  intersect the tree, preserved as shared when a live outside session also
  references it, preserved when there is no tree linkage at all.

No change to `deleteTeamRunDataPersistent` (SQLite/Postgres transactions), the
Session tree traversal, Worktree/Agent/Note survivor-first protection, or the
lane-session creation path. `sharedKanbanTaskIds` is now reserved for legacy
(no-`teamRunId`) cards.

### Tests

`src/core/orchestration/__tests__/team-run-deletion.test.ts` and
`src/app/api/team-runs/__tests__/route.test.ts` updated/extended. The test
`preserves explicitly owned cards that a live outside session still references`
locked the buggy semantics and was replaced. Coverage now includes:

- Explicit card, no session refs → deleted.
- Explicit card, only a nonexistent session → deleted.
- Explicit card whose only live session is a parentless lane session → deleted
  (the real-world regression).
- Explicit card linking both in-tree and live outside sessions → deleted.
- Card owned by another Team but linked to this tree → preserved.
- Legacy card linked only to the tree → deleted.
- Legacy card linked to tree + live outside session → preserved.
- No ownership and no tree linkage → preserved.
- Artifacts deleted only with actually-deleted cards.
- Shared worktree still protected by a surviving card even when an explicit
  card referencing it is deleted.
- Preview `explicit`/`legacy`/`preserved` counts match the executed deletion.

### Verification evidence

- Focused Vitest (`team-run-deletion`, `team-run-identity`, team-runs API,
  delete dialog): all pass (27 + 3 route + identity + 6 dialog assertions).
- `npx tsc --noEmit`: pass, no errors.
- `entrix run --dry-run`: PASS, 100%.
- `entrix run --tier fast`: PASS, 100% (includes `ts_test_pass` and
  `ts_typecheck_pass` hard gates).
- Full TypeScript hard gate `ts_test_pass_full` (`npm run test:run` =
  `vitest run`): **401 files / 2677 tests passed, 23 skipped, 0 failed.**

### Environmental note (not caused by this fix)

`entrix run --tier normal` additionally runs the `rust_test_pass` hard gate
(`cargo test --workspace`). That gate failed on **4 pre-existing Rust tests**
that perform network I/O, all returning `502 Bad Gateway`:

- `acp::binary_manager::tests::download_archive_uses_caller_provided_http_client`
- `rpc::methods::kanban::github::tests::create_issue_from_card_links_existing_task`
- `rpc::methods::kanban::github::tests::sync_github_issues_creates_and_updates_tasks`
- `rpc::methods::kanban::github::tests::sync_github_issues_dry_run_does_not_mutate_store`

These are unrelated to this change: no `crates/` files are modified (`git diff
HEAD -- crates/` is empty), and the failures are upstream gateway errors in
tests that spawn HTTP servers / call the GitHub API. The remaining 233 Rust
tests passed. This fix is TypeScript-only (`src/core/orchestration/` and its
tests), and every hard gate relevant to it passes.

### Historical orphaned cards

Per the scope boundary, this fix only repairs the normal Team Run deletion path
so no new residue is produced. It does **not** auto-clean cards whose Team Run
root is already gone from inside the DELETE endpoint. A separate,
confirmation-gated workspace cleanup already exists for that case in
`src/core/orchestration/unassigned-team-cards.ts`
(`previewUnassignedHistoricalCards` / `deleteUnassignedHistoricalCards`), which
recomputes the target set at deletion time and removes card records only.
No user database was modified and no implicit/bulk deletion was performed.

## References

- [Team Run deletion ownership boundaries](../design-docs/team-run-deletion-ownership-boundaries.md)
