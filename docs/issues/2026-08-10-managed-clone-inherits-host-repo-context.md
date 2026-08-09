---
title: "Managed clone inherits host repository agent context"
date: "2026-08-10"
status: resolved
resolved_at: "2026-08-10"
severity: high
area: codebases
tags: [codebase, clone, agents, cwd, context, desktop]
reported_by: "Codex"
related_issues:
  - "2026-04-02-desktop-workspace-db-and-port-mismatch.md"
---

# Managed clone inherits host repository agent context

## What Happened

Routa was running from `/Users/xie/Documents/vibecoding/Loom-v2/routa` and cloned the selected `xhxfafafa/personal` repository to:

```text
/Users/xie/Documents/vibecoding/Loom-v2/routa/.routa/repos/xhxfafafa--personal
```

The parent session received this Personal path as its `cwd`, and delegated child worktrees were created from the correct Personal remote. However, the managed clone was physically nested below the Routa source repository. Coding-agent context discovery could therefore walk into the outer Routa repository and load its `AGENTS.md` or related repository context. The parent then produced Loom/Routa-oriented tasks that were inherited by child agents.

## Expected Behavior

- Managed codebase clones must live outside the repository hosting the Routa server.
- Selecting Personal must give parent and child agents only Personal repository instructions and code context.
- Existing managed clones should migrate without deleting the legacy copy, so historical sessions retain their original cwd.

## Root Cause

`getCloneBaseDir()` used `bridge.env.currentDir()/.routa/repos` for local servers. When Routa itself ran from a source checkout, every managed clone became a nested Git repository under that source checkout.

## Relevant Files

- `src/core/git/git-utils.ts`
- `src/app/api/workspaces/[workspaceId]/codebases/route.ts`
- `src/core/git/__tests__/git-utils.test.ts`

## Verification Plan

- Verify the default local clone root is `~/.routa/repos` rather than `<server cwd>/.routa/repos`.
- Verify a registered legacy clone is copied to the detached root and its codebase record is updated.
- Verify the Personal repo path shown by the UI no longer has the Routa checkout as an ancestor.
- Run focused tests and the fast fitness tier.

## Resolution

- Local managed clones now default to `~/.routa/repos`, with `ROUTA_CLONE_BASE_DIR` available as an explicit override.
- The previous `<server cwd>/.routa/repos` location is recognized as a legacy managed root.
- Listing workspace codebases performs a compatibility migration: it copies a legacy managed clone to the detached root, retains the source for historical session recovery, and updates the codebase record for all new sessions.
- Repositories outside the legacy managed root remain untouched.

## Verification

- Focused clone-root, migration, and Canvas compatibility suites — 30 tests passed.
- The live `default` workspace codebase record changed from `/Users/xie/Documents/vibecoding/Loom-v2/routa/.routa/repos/xhxfafafa--personal` to `/Users/xie/.routa/repos/xhxfafafa--personal`.
- The detached copy retains `origin https://github.com/xhxfafafa/personal.git`; the legacy copy remains present for historical sessions.
- Browser verification shows `xhxfafafa/personal` with repository path `/Users/xie/.routa/repos/xhxfafafa--personal`, which no longer has the Routa checkout as an ancestor.
- `cargo run -p entrix -- run --tier fast` — passed with score 100; all code, contract, dependency, lint, typecheck, clippy, and incremental test gates passed. `npm_audit_critical` was reported as infrastructure `UNKNOWN` because npm rejected the quick-audit request for the existing package tree.
