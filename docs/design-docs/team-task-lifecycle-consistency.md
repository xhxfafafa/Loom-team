---
title: Team Task Lifecycle Consistency
status: accepted
purpose: Keep delegated Team tasks visible and terminal tasks consistent with Kanban.
---

# Team Task Lifecycle Consistency

## Problem

Two symptoms share one missing lifecycle contract:

1. A Team child Agent can be running while its persisted Task has no child Session binding, so
   Team and Kanban cannot show the execution consistently.
2. A Task can be `COMPLETED` or `BLOCKED` while `columnId` is empty or stale, so Kanban displays it
   in Backlog and still offers Run.

## Decisions

The existing `Task` remains the canonical work item. No second card model, background repair job,
or new state machine is introduced.

### Delegation binding

Both Web and Rust delegation use this order:

1. Serialize delegates for the same Task inside the orchestrator instance.
2. Re-read the Task and reuse an existing active Agent/Session binding when present.
3. Create the pending Agent and child Session without sending the prompt.
4. Save the Task once with:
   - `assignedTo = child agent id`
   - `status = IN_PROGRESS`
   - `sessionIds` containing the child Session exactly once
   - `teamRunId = root Team Session`
   - the original `sessionId` unchanged
5. Only after the save succeeds, activate the Agent, publish the started event, and send the prompt.

If Session creation or binding persistence fails, stop the new runtime and mark the new Agent
`ERROR`. If prompt startup fails after binding, re-read the Task, verify it is still owned by that
Agent/Session, then move it to `BLOCKED`.

The in-process guard matches the current deployment model. Cross-process ownership arbitration and
crash recovery are separate problems and are not part of this fix.

### Team task source

The Team page loads Tasks using `GET /api/tasks?workspaceId=...&teamRunId=...` and renders those
persisted Tasks as the primary task tree. Task-shaped Notes remain a read-only compatibility source
for historical runs and are deduplicated by `linkedTaskId`.

Delegation transcript parsing prefers structured `taskId`, `sessionId`, and `status` fields, while
retaining a bounded compatibility parser for JSON/string/MCP wrappers.

### Session display

Kanban card rows, details, and execution panels use `getPreferredTaskSessionId()`:

1. `triggerSessionId`
2. latest `laneSessions` entry
3. latest `sessionIds` entry

Display selection and Run eligibility stay separate. Run is hidden for terminal or queued tasks and
for tasks with a currently live Session; a dead historical Session does not permanently disable it.

### Terminal status and column

Web and Rust share the same small transition rule:

```text
applyTaskStatusTransition(task, nextStatus, board)
  -> set status
  -> COMPLETED maps to the board's done-stage column
  -> BLOCKED maps to the board's blocked-stage column
  -> update timestamp
  -> caller saves once
```

Board lookup order is Task board, workspace default board, then no board context. With no board
context, literal `done`/`blocked` is the compatibility fallback. `NEEDS_FIX` does not move columns.

All existing mutation entry points that write terminal task status call this helper or its Rust
equivalent. No repository-wide source scanner is added; behavior is protected by focused tests.

Read-side projection treats terminal `Task.status` as authoritative, so historical
`COMPLETED + empty columnId` rows display in Done without a data migration.

## API and persistence

- `Task.sessionId` keeps its creation-session meaning.
- `Task.sessionIds` stores delegated child Session history.
- `Task.teamRunId` stores Team ownership and is persisted by both backends.
- `GET /api/tasks` accepts optional `teamRunId`, scoped by workspace.
- Delegation results keep `taskId`, `agentId`, and `sessionId`, with `status = delegated`.

## Validation

Focused tests cover:

- binding is saved before activation and prompt dispatch;
- active binding reuse and same-instance concurrent delegate serialization;
- failed Session creation/persistence/prompt startup;
- Team task tree from persisted Tasks with legacy Note compatibility;
- preferred Session selection and Run gating;
- custom terminal board columns and historical empty-column rows;
- Web/Rust `teamRunId` API filtering with workspace isolation.

## Non-goals

- Cross-process delegation arbitration.
- Recovery from an ungraceful crash between process creation and Task persistence.
- Automatic historical data backfill.
- GitHub Issue synchronization state.
- Team activity timestamp or transcript-loading performance.
