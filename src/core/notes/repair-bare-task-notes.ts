/**
 * Bounded repair for malformed bare task Notes.
 *
 * A "bare task Note" carries `metadata.type === "task"` but none of the
 * explicit task-semantic fields (linkedTaskId, taskStatus, parentNoteId, or a
 * non-empty assignment). Such Notes are documents — usually completion or
 * verification reports written through the generic create_note path before
 * the write boundary was closed — and must be reclassified to `general`.
 *
 * Rules (design: docs/design-docs/team-report-note-task-tree-classification.md):
 * - Dry-run by default; writes happen only with an explicit `apply: true`.
 * - Always scoped by workspace, optionally narrowed to one Team Run/session.
 * - Only bare task Notes are eligible; structured and legacy task Notes are
 *   never touched. Classification never uses titles, content, or IDs.
 * - Idempotent: re-running after an apply finds no candidates.
 * - Goes through the NoteStore API so both SQLite and Postgres stores are
 *   supported without backend-specific SQL.
 */

import { hasTaskSemanticMetadata, Note } from "../models/note";
import { NoteStore } from "../store/note-store";

export interface RepairBareTaskNotesOptions {
  workspaceId: string;
  /** Optional Team Run / session scope limiting the repair. */
  sessionId?: string;
  /** Dry-run unless explicitly true. */
  apply?: boolean;
}

export interface RepairBareTaskNotesCandidate {
  noteId: string;
  title: string;
  workspaceId: string;
  sessionId?: string;
}

export interface RepairBareTaskNotesResult {
  mode: "dry-run" | "apply";
  workspaceId: string;
  sessionId?: string;
  candidates: RepairBareTaskNotesCandidate[];
  reclassified: string[];
}

export function isBareTaskNote(note: Note): boolean {
  return note.metadata.type === "task" && !hasTaskSemanticMetadata(note.metadata);
}

export async function repairBareTaskNotes(
  noteStore: NoteStore,
  options: RepairBareTaskNotesOptions,
): Promise<RepairBareTaskNotesResult> {
  const mode: RepairBareTaskNotesResult["mode"] = options.apply ? "apply" : "dry-run";
  const notes = await noteStore.listByWorkspace(options.workspaceId);

  const candidates = notes.filter((note) => {
    if (options.sessionId && note.sessionId !== options.sessionId) return false;
    return isBareTaskNote(note);
  });

  const result: RepairBareTaskNotesResult = {
    mode,
    workspaceId: options.workspaceId,
    sessionId: options.sessionId,
    candidates: candidates.map((note) => ({
      noteId: note.id,
      title: note.title,
      workspaceId: note.workspaceId,
      sessionId: note.sessionId,
    })),
    reclassified: [],
  };

  if (mode === "dry-run") return result;

  for (const note of candidates) {
    // Reclassify only the type discriminator; content, session ownership,
    // timestamps, and any custom metadata are preserved as-is.
    const repaired: Note = { ...note, metadata: { ...note.metadata, type: "general" } };
    await noteStore.save(repaired, "system");
    result.reclassified.push(note.id);
  }

  return result;
}
