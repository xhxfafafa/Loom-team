---
title: "Team repository selection is not inherited by Kanban cards"
date: "2026-08-10"
status: resolved
resolved_at: "2026-08-10"
severity: high
area: team-kanban
tags: [team, codebase, kanban, mcp, workspace]
reported_by: "User"
---

# Team repository selection is not inherited by Kanban cards

## What Happened

The Team landing page repository picker allowed the user to select a cloned
repository such as `xhxfafafa/Loom` and correctly launched the Team Run with
that repository as its `cwd`. Cards created by the Team Lead and its child
agents were nevertheless stored or displayed with the workspace default
codebase, `xhxfafafa/personal`.

## Expected Behavior

- Sending a Team request with a selected repository must attach that repository
  to the current workspace when it is not already a registered codebase.
- The Team Run root and every descendant agent must create tasks and Kanban
  cards with that codebase ID.
- Existing Team-owned cards should be repairable from the owning Team Run root
  session `cwd` when the recorded codebase is missing or incorrect.
- An unassigned card must not silently appear to belong to the default codebase.

## Root Cause

`HomeInput` passed the selected repository only as the ACP session `cwd`. Its
repository picker intentionally includes cloned repositories that have not been
registered as workspace codebases, but the send path did not register them.

The MCP `create_task`, `create_card`, `decompose_tasks`, and
`convert_task_blocks` paths stamped the owning `teamRunId`, but did not derive
or persist `codebaseIds` from the Team Run root session. Kanban UI fallback
logic then assigned or displayed the workspace default codebase.

## Relevant Files

- `src/client/components/home-input.tsx`
- `src/core/mcp/routa-mcp-tool-manager.ts`
- `src/core/tools/agent-tools.ts`
- `src/core/tools/kanban-tools.ts`
- `src/core/tools/note-tools.ts`
- `src/app/workspace/[workspaceId]/kanban/kanban-tab.tsx`
- `src/app/workspace/[workspaceId]/kanban/kanban-card.tsx`

## Verification Plan

- Verify selecting an unregistered cloned repository registers it before the
  Team session starts.
- Verify Team Lead and nested agents inherit the Team root codebase in every
  supported task/card creation path.
- Verify ordinary sessions cannot forge or inherit Team repository ownership.
- Verify existing Team cards with the wrong repository are repaired from the
  Team root session `cwd` once the codebase is registered.
- Run focused Vitest suites and the repository fitness gates.

## Resolution

- Team launch mode now registers the explicitly selected repository in the
  current workspace before creating the root session, without changing the
  workspace default codebase.
- Web and desktop MCP paths derive Team ownership from the server-trusted
  session tree, match the root `cwd` to an exact registered codebase, and stamp
  that codebase before task/card persistence and lane automation.
- Kanban no longer displays the default repository for unassigned cards and
  repairs historical Team cards only from an exact Team-root `cwd` match.
- Ordinary sessions remain unassigned and client-supplied Team ownership is
  ignored.

## Verification

- Focused Vitest: 9 files passed; 89 tests passed and 12 skipped.
- TypeScript typecheck: passed.
- Rust compile and focused Team/card tests: passed.
- Entrix file-size, dependency, API-contract, lint, typecheck, clippy, and full
  TypeScript test gates: passed.
- The full repository Rust gate reached the unrelated `trace-parser` Qoder
  discovery test and failed because the local Qoder projects root was absent;
  all `routa-core`, `routa-server`, and Rust API tests relevant to this change
  passed. The global coverage gate remains below its repository-wide 80%
  target (62.1%), independent of this incident.
