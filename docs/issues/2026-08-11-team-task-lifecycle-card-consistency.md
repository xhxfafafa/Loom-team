---
title: "Team delegated tasks lose session and Kanban lifecycle consistency"
date: "2026-08-11"
status: resolved
resolved_at: "2026-08-12"
severity: high
area: "team-kanban"
tags: [team, delegation, task, session, kanban, web, rust]
reported_by: "Codex"
github_state: null
github_url: null
related_issues: []
---

# Team delegated tasks lose session and Kanban lifecycle consistency

## What Happened

Two lifecycle breaks make valid Team work look missing or unfinished:

1. A delegated child agent can have a real Task and child Session, while the Team UI has no stable
   task-to-agent-to-session binding from which to render its card.
2. A child agent can complete a Task with `status: COMPLETED`, while `columnId` remains empty. The
   Kanban UI then falls back to Backlog and may still offer Run.

## Expected Behavior

- Successful delegation makes the Task and child Session immediately discoverable in Team UI.
- Delegation preserves `Task.sessionId` as the creating Session and records child execution in
  deduplicated `sessionIds`.
- Successful completion stores both the domain status and its Kanban projection consistently.
- Historical rows with a terminal status remain terminal in the UI even if their `columnId` is
  missing or stale.
- Next.js and Rust/Axum preserve the same behavior.

## Confirmed Causes

- The MCP delegation result is structured, but its transcript representation can place `sessionId`
  inside a string-valued `rawOutput`; the Team page parser expects `rawOutput.output` and does not
  consistently recognize `status: delegated`.
- Team's task tree is derived from task-shaped Notes instead of the persisted Task collection.
- Several terminal-status mutation paths, including `report_to_parent` and `update_task_status`,
  update `Task.status` without resolving `Task.columnId` in one or both backends.
- Kanban grouping and Run eligibility treat `columnId` as the only lifecycle signal.
- Kanban card/detail consumers do not consistently use the existing preferred-session resolver, so
  a child Session stored in `sessionIds` can still appear absent.

## Scope

The fix is limited to persistence and projection consistency for existing `Task`, `Agent`,
`Session`, and Kanban fields. It does not introduce a new task model, workflow engine, distributed
transaction, or automatic historical data migration.

## Proposed Resolution

Implement [Team task lifecycle consistency](../design-docs/team-task-lifecycle-consistency.md) as
two independently reviewable changes:

1. Persist and expose delegation bindings, then render Team tasks from Tasks rather than Notes.
2. Synchronize terminal status with the terminal Kanban stage and add a read-side compatibility
   projection for existing inconsistent rows.

The implementation also aligns the Rust `team_run_id` model/store representation and the shared
API contract. Activity timestamps, transcript-loading performance, and crash-only recovery remain
outside this issue.

## Resolution

The reduced implementation now provides same-instance delegation serialization, persists the
Task/child-Session binding before prompt dispatch, renders the Team tree from persisted Tasks, and
applies shared terminal status/column transitions in both backends.

Targeted Web, Rust orchestration, Kanban, and Rust API tests pass. Entrix fast passes at 100%. The
normal suite's relevant tests pass; its remaining failures are pre-existing repository-wide
coverage debt and an unrelated A2A RPC test for a route absent from the baseline server.
