/**
 * Note classification contract shared by every agent-facing note creation
 * surface (MCP tool definitions, NoteTools domain boundary).
 *
 * Invariants I2/I3 from
 * `docs/design-docs/team-report-note-task-tree-classification.md`:
 * documents (reports, research, verification, handoffs, summaries) are
 * `general` Notes; `task` Notes are structured task mirrors that must carry
 * explicit task semantics and are created through `create_task` or
 * `convert_task_blocks`, never through generic note creation.
 */

export const NOTE_CLASSIFICATION_GUIDANCE =
  "Use general for reports, research, verification, handoffs, and completion summaries. "
  + "Task notes are structured task mirrors and must be created through create_task or "
  + "convert_task_blocks, not generic create_note.";

export const BARE_TASK_NOTE_REJECTION =
  'create_note cannot create type "task" notes. Reports, research, verification, handoffs, '
  + 'and completion summaries must use type "general". Canonical work items are created with '
  + "create_task; structured task mirrors linked to @@@task blocks are created with convert_task_blocks.";
