---
title: Team Report Note and Task Tree Classification
status: proposed
purpose: Prevent completion-report Notes from appearing as unfinished Team tasks while preserving explicit legacy task Notes.
---

# Team Report Note and Task Tree Classification

## Decision summary

The persisted `Task` is the only canonical work item in a Team Run. A Note is a document and must
not enter the Team task tree merely because its `metadata.type` equals `"task"`.

This design adds two complementary protections:

1. Agent-facing note creation must classify completion reports, verification reports, research
   reports, handoff summaries, and other deliverables as `general` Notes. The generic
   `create_note` tool must not create unlinked task Notes.
2. The Team task-tree compatibility path may render an old task Note only when the Note contains
   explicit task semantics such as `linkedTaskId`, `taskStatus`, `parentNoteId`, or an assignment.
   A bare `type: "task"` discriminator is insufficient.

This refines the legacy-Note compatibility rule in
`docs/design-docs/team-task-lifecycle-consistency.md`. It does not change the canonical `Task`
lifecycle, Kanban automation, or `report_to_parent` completion behavior.

## User-visible failure

On a completed Team Run, the conversation and deliverables can show successful implementation,
commits, push verification, and QA approval while the left task tree still shows report-shaped
rows as `NOT STARTED` with an empty status circle.

Confirmed example:

```text
Team Run: 260d08a9-f18f-42d6-9bce-f40f5ee97e7f

Report Notes rendered as tasks:
- report-code-quality-architecture
- task-p0-1-dep-security-report
- task-p0-2-contact-form-report
```

All three records had this effective shape:

```ts
{
  sessionId: "260d08a9-f18f-42d6-9bce-f40f5ee97e7f",
  metadata: { type: "task" },
  // no taskStatus
  // no linkedTaskId
  // no parentNoteId
  // no assignedAgentIds
}
```

The persisted Tasks referenced by the reports were independently verified through
`GET /api/tasks?workspaceId=default&teamRunId=<run-id>` and were already `COMPLETED`. The failure is
therefore a duplicate projection/classification defect, not lost task completion.

## Root cause

The defect crosses the write and read boundaries.

### Write boundary

`create_note` exposes `spec | task | general` but describes the values only as generic note types.
An agent can reasonably choose `task` for a document whose subject is a task, including a completion
report. `NoteTools.createNote` then persists only the discriminator:

```ts
metadata: { type: params.type ?? "general" }
```

The generic tool cannot provide `linkedTaskId`, `taskStatus`, `parentNoteId`, or assignment metadata,
so `type: "task"` created through this path is structurally incomplete by construction.

The valid structured task-Note path is `convert_task_blocks`. It creates a persisted `Task` and a
task Note containing `taskStatus`, `parentNoteId`, and `linkedTaskId` together.

### Read boundary

`buildTeamTaskTree()` correctly renders persisted Tasks first, but its compatibility filter accepts
every Note with `metadata.type === "task"` when there is no matching `linkedTaskId`.

The legacy node then calls:

```ts
normalizeTaskStatus(note.metadata.taskStatus)
```

`normalizeTaskStatus(undefined)` returns `"not-started"`. Consequently, an unlinked completion
report becomes a second, unfinished-looking task even though the canonical Task is complete.

## Domain invariants

The implementation must enforce the following invariants.

### I1. Canonical work identity

- `Task.id` identifies work.
- `Task.status` is the source of truth for lifecycle state.
- A report title containing a task ID is not a task relationship.
- UI code must not infer task identity from Note IDs, titles, or content.

### I2. Note type semantics

- `spec`: workspace specification or planning source.
- `task`: a structured compatibility mirror of a task, containing explicit task metadata.
- `general`: reports, research, decisions, verification results, handoffs, summaries, and other
  collaborative documents.

The subject of a document does not determine its Note type. A report about a task remains
`general`.

### I3. Valid task Note

A task Note is valid for task-tree projection when at least one explicit task-semantic field is
present:

```ts
metadata.type === "task" && (
  Boolean(metadata.linkedTaskId) ||
  Boolean(metadata.taskStatus) ||
  Boolean(metadata.parentNoteId) ||
  Boolean(metadata.assignedAgentIds?.length)
)
```

`linkedTaskId` remains the strongest identity signal. The additional fields exist only to retain
read-only compatibility with historical task Notes created before durable Task linkage.

A Note with only `metadata.type === "task"` is malformed and must not appear in the Team task tree.

### I4. No title heuristics

Do not detect reports using strings such as `report`, `完成报告`, `verification`, task-ID suffixes,
or known Note-ID prefixes. Titles are localized, user-editable content and are not a stable schema.

## Required implementation

### 1. Centralize legacy task-Note eligibility

In `src/app/workspace/[workspaceId]/team/[sessionId]/team-run-page-model.ts`, introduce a small pure
predicate, for example:

```ts
export function isLegacyTaskNote(note: NoteData): boolean {
  if (note.metadata.type !== "task") return false;
  return Boolean(
    note.metadata.linkedTaskId ||
    note.metadata.taskStatus ||
    note.metadata.parentNoteId ||
    note.metadata.assignedAgentIds?.length
  );
}
```

Use it before the existing `linkedTaskId` deduplication:

```ts
const legacyNotes = notes.filter((note) => {
  if (!isLegacyTaskNote(note)) return false;
  const linkedTaskId = note.metadata.linkedTaskId;
  return !linkedTaskId || !linkedTaskIds.has(linkedTaskId);
});
```

Keep the following behavior:

- persisted Tasks are always rendered;
- a task Note linked to a loaded persisted Task is deduplicated;
- a task Note linked to a missing historical Task may still render as a legacy node;
- an unlinked historical task Note with explicit status/hierarchy/assignment metadata may still
  render;
- a bare task-typed report Note is excluded.

Do not silently convert excluded Notes in React state. Classification repair belongs at the write
or persistence boundary.

### 2. Close the agent-facing write gap

Update both MCP tool-definition surfaces so their contract is identical:

- `src/core/mcp/mcp-tool-executor.ts`
- `src/core/mcp/routa-mcp-tool-manager.ts`

The `create_note` description must explicitly state:

```text
Use general for reports, research, verification, handoffs, and completion summaries.
Task notes are structured task mirrors and must be created through create_task or
convert_task_blocks, not generic create_note.
```

Prompt wording alone is not a sufficient guard. At the shared `NoteTools.createNote` boundary,
reject `type: "task"` from generic creation with an actionable error directing the caller to
`create_task` or `convert_task_blocks`.

Keep internal structured creation in `convertTaskBlocks()` unchanged. The REST Note API may retain
`task` for the collaborative task editor and compatibility imports, because those callers can
provide structured metadata. If REST creation accepts `type: "task"`, validate that it also carries
at least one task-semantic field from invariant I3; return HTTP 400 for a bare task Note.

The preferred end state is:

```text
generic create_note(type=general)        -> document/report
create_task                              -> canonical Task
convert_task_blocks                      -> canonical Task + linked compatibility Note
REST task Note with semantic metadata    -> supported compatibility/editor path
bare task Note                           -> rejected
```

### 3. Preserve deliverables

Reclassifying a report as `general` must not remove it from Team deliverables. The current Team
deliverables projection reads all Notes, so no filter by `metadata.type === "task"` should be added.

This change is about removing false task nodes, not hiding reports. If an implementation changes
deliverable status semantics, that must be a separate concern and commit.

### 4. Repair existing malformed records safely

The read-side predicate fixes the misleading UI immediately without mutating persistence.

For stored data, provide a bounded repair path with dry-run output. A record is eligible for
automatic reclassification from `task` to `general` only when all task-semantic fields in I3 are
absent. The repair must:

1. scope by workspace, with optional Team Run/session scope;
2. print Note ID, title, workspace, and session before changing anything;
3. default to dry-run;
4. require an explicit apply flag;
5. preserve content, timestamps where supported, session ownership, and custom metadata;
6. be idempotent;
7. support both configured SQLite and Postgres stores through domain/store APIs rather than raw
   backend-specific SQL where practical.

Do not classify using title text. Do not run a repository-wide destructive migration as part of a
page render or application startup.

For the confirmed Team Run above, the three exact Note IDs may be repaired after the general rule's
dry-run output has been reviewed.

## API behavior

Generic MCP creation:

```json
{
  "title": "P0 verification report",
  "type": "task"
}
```

must return a structured failure whose message explains that reports use `general` and canonical
work uses `create_task`/`convert_task_blocks`.

REST creation of a bare task Note must return `400`:

```json
{
  "error": "Task notes require task metadata such as linkedTaskId or taskStatus. Use type 'general' for reports."
}
```

Existing stored malformed Notes must remain readable and editable through the Notes API; they are
only excluded from task-tree projection until repaired.

## Test matrix

### Team task-tree model

Add focused tests in
`src/app/workspace/[workspaceId]/team/[sessionId]/__tests__/team-run-page-model.test.ts`:

1. A persisted `COMPLETED` Task renders exactly once as `done`.
2. A bare `{ type: "task" }` report Note does not render in the task tree.
3. The same report remains available to the independent deliverables projection or a focused
   deliverables test.
4. A Note linked to a loaded Task is deduplicated.
5. A Note linked to a missing historical Task renders as legacy.
6. An unlinked Note with `taskStatus: PENDING` renders as legacy `not-started`.
7. An unlinked Note with `parentNoteId` or assignment metadata remains eligible.
8. `isLegacyTaskNote` does not inspect Note ID, title, or content.

Include a regression fixture matching the confirmed failure: completed persisted tasks plus report
Notes whose only metadata is `{ type: "task" }`.

### MCP and domain write boundary

Cover both tool-registration paths and the shared domain boundary:

1. `create_note` defaults to `general`.
2. `create_note(type="general")` succeeds for a completion report.
3. `create_note(type="task")` fails with actionable guidance.
4. `convert_task_blocks` still creates a linked task Note with status and parent metadata.
5. The two MCP schema descriptions carry the same classification guidance.

### REST Note API

1. A bare REST task Note is rejected with HTTP 400.
2. A structured task Note with `linkedTaskId` or `taskStatus` remains accepted.
3. Updating an existing valid task Note preserves its task metadata.
4. Existing malformed task Notes remain readable.
5. A report created as `general` is returned by workspace Note listing.

### Repair path

1. Dry-run performs no writes.
2. Only bare task Notes are selected.
3. Valid linked and legacy task Notes are skipped.
4. Apply reclassifies eligible rows and is idempotent.
5. Workspace and Team Run/session scoping are enforced.

## Manual acceptance walkthrough

1. Open a Team Run containing completed persisted Tasks and bare task-typed report Notes.
2. Confirm every canonical completed Task has one checked `DONE` row.
3. Confirm the completion reports remain visible in Deliverables but not in the task tree.
4. Ask an Agent to save a new completion report using `create_note`; verify it uses `general`.
5. Attempt generic `create_note(type="task")`; verify the tool rejects it with remediation text.
6. Create a structured task via `create_task` or `convert_task_blocks`; verify it appears once in the
   task tree and follows the persisted Task lifecycle.
7. Refresh the page and repeat the checks to prove the result is persistence-backed.

Use `agent-browser` for the walkthrough and keep screenshots in an ignored temporary path. UI-facing
changes require screenshot evidence in the PR body.

## Implementation sequence and commit boundaries

Keep the work in baby-step commits:

1. `test(team): characterize report notes misclassified as tasks`
2. `fix(team): require semantic metadata for legacy task notes`
3. `fix(notes): reject bare task notes from generic creation`
4. `fix(notes): validate structured task metadata in notes API`
5. `chore(notes): add scoped malformed-note repair` (only if the repair is implemented in the same
   delivery)

Avoid mixing unrelated deliverable-status, timeline-refresh, or visual redesign work into these
commits.

## Validation

Run targeted tests first, then repository gates:

```bash
npx vitest run 'src/app/workspace/[workspaceId]/team/[sessionId]/__tests__/team-run-page-model.test.ts'
npx vitest run src/core/mcp/__tests__/mcp-tool-executor.test.ts
npx vitest run src/core/mcp/__tests__/routa-mcp-tool-manager.test.ts
npx vitest run src/app/api/notes
npm run fitness:run -- --tier fast --scope local --min-score 0
npm run fitness:run -- --tier normal --scope local --min-score 0
npm run validate:web
```

If shell globbing affects bracketed paths, quote the path as shown or use the repository's supported
test-name filter.

## Definition of done

- Completion-report Notes no longer appear as unfinished Team tasks.
- Canonical completed Tasks continue to render exactly once as checked `DONE` rows.
- Reports remain visible as Team deliverables.
- Generic agent note creation cannot persist a bare task Note.
- Structured and historical task Notes retain their supported compatibility behavior.
- No title/content heuristic is introduced.
- Existing malformed records have a reviewed dry-run repair option or a documented bounded manual
  repair procedure.
- Targeted tests and all required repository validation gates pass.
- Browser evidence demonstrates task-tree correctness before the issue is marked resolved.

## Non-goals

- Replacing the `Task` model or introducing another workflow state machine.
- Changing Kanban terminal-column transitions.
- Inferring task completion from report text, Git commits, or QA prose.
- Automatically approving general deliverables.
- Redesigning the Team task-tree UI.
- Fixing Team transcript refresh or scroll-follow behavior.

## Related records

- `docs/issues/2026-08-18-team-report-notes-render-as-unfinished-tasks.md`
- `docs/design-docs/team-task-lifecycle-consistency.md`
- `docs/issues/2026-08-11-team-task-lifecycle-card-consistency.md`
