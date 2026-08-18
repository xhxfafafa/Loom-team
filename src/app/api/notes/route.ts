/**
 * /api/notes - REST API for collaborative note editing.
 *
 * GET    /api/notes?workspaceId=...&type=...  → List notes
 * GET    /api/notes?workspaceId=...&sessionId=...  → List notes filtered by session
 * GET    /api/notes?workspaceId=...&groupBy=session  → List notes grouped by session
 * POST   /api/notes                           → Create/update a note
 * DELETE /api/notes?noteId=...&workspaceId=... → Delete a note
 */

import { NextRequest, NextResponse } from "next/server";
import { getRoutaSystem } from "@/core/routa-system";
import { getHttpSessionStore } from "@/core/acp/http-session-store";
import { createNote, hasTaskSemanticMetadata, Note } from "@/core/models/note";

/**
 * Task Notes are structured task mirrors. Creation through this API must
 * carry at least one explicit task-semantic field (linkedTaskId, taskStatus,
 * parentNoteId, or a non-empty assignment); a bare `type: "task"` Note is a
 * misclassified document and is rejected with guidance to use `general`.
 * Updates of existing Notes stay permissive so historical records remain
 * readable and editable.
 */
function validateTaskNoteCreation(type: string, metadata: Record<string, unknown> | undefined): NextResponse | null {
  if (type !== "task") return null;
  if (hasTaskSemanticMetadata(metadata as Parameters<typeof hasTaskSemanticMetadata>[0])) return null;
  return NextResponse.json(
    {
      error:
        "Task notes require task metadata such as linkedTaskId or taskStatus. Use type 'general' for reports.",
    },
    { status: 400 },
  );
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const workspaceId = searchParams.get("workspaceId");
  const type = searchParams.get("type") as "spec" | "task" | "general" | null;
  const noteId = searchParams.get("noteId");
  const sessionIdFilter = searchParams.get("sessionId");
  const groupBy = searchParams.get("groupBy");

  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
  }

  const system = getRoutaSystem();

  // Single note fetch
  if (noteId) {
    const note = await system.noteStore.get(noteId, workspaceId);
    if (!note) {
      return NextResponse.json({ error: "Note not found" }, { status: 404 });
    }
    return NextResponse.json({ note: serializeNote(note) });
  }

  // List notes
  let notes = type
    ? await system.noteStore.listByType(workspaceId, type)
    : await system.noteStore.listByWorkspace(workspaceId);

  // Filter by sessionId if provided — strict match only.
  if (sessionIdFilter) {
    notes = notes.filter((note) => note.sessionId === sessionIdFilter);
  }

  // Group by session if requested
  if (groupBy === "session") {
    // Collect unique session IDs
    const sessionIds = [...new Set(notes.map((n) => n.sessionId).filter(Boolean))] as string[];

    // Fetch session info for all unique session IDs from HttpSessionStore
    const httpSessionStore = getHttpSessionStore();
    await httpSessionStore.hydrateFromDb();
    const allSessions = httpSessionStore.listSessions();
    const sessionMap = new Map<string, { id: string; name?: string }>();
    for (const sessionId of sessionIds) {
      const session = allSessions.find((s) => s.sessionId === sessionId);
      if (session) {
        sessionMap.set(sessionId, { id: session.sessionId, name: session.name });
      }
    }

    // Group notes by sessionId
    interface SessionGroup {
      sessionId: string | null;
      sessionName: string | null;
      notes: ReturnType<typeof serializeNote>[];
    }

    const groups: SessionGroup[] = [];
    const notesBySession = new Map<string | null, Note[]>();

    for (const note of notes) {
      const key = note.sessionId ?? null;
      const existing = notesBySession.get(key) ?? [];
      existing.push(note);
      notesBySession.set(key, existing);
    }

    for (const [sessionId, sessionNotes] of notesBySession) {
      const sessionInfo = sessionId ? sessionMap.get(sessionId) : null;
      groups.push({
        sessionId: sessionId,
        sessionName: sessionInfo?.name ?? null,
        notes: sessionNotes.map(serializeNote),
      });
    }

    // Sort: groups with session first (by name), then ungrouped at the end
    groups.sort((a, b) => {
      if (a.sessionId === null && b.sessionId !== null) return 1;
      if (a.sessionId !== null && b.sessionId === null) return -1;
      return (a.sessionName ?? "").localeCompare(b.sessionName ?? "");
    });

    return NextResponse.json({ groups });
  }

  return NextResponse.json({
    notes: notes.map(serializeNote),
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const {
    noteId,
    title,
    content,
    workspaceId,
    sessionId,
    type = "general",
    metadata,
    source: rawSource = "user",
  } = body;

  // Validate source type
  const source = (["agent", "user", "system"].includes(rawSource) ? rawSource : "user") as "agent" | "user" | "system";

  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
  }

  const system = getRoutaSystem();
  const store = system.noteStore;

  // Update existing note
  if (noteId) {
    const existing = await store.get(noteId, workspaceId);
    if (existing) {
      if (content !== undefined) existing.content = content;
      if (title !== undefined) existing.title = title;
      if (sessionId !== undefined) existing.sessionId = sessionId;
      if (metadata) Object.assign(existing.metadata, metadata);
      existing.updatedAt = new Date();

      await store.save(existing, source);

      // Broadcast update for real-time sync (PgNoteStore/SqliteNoteStore don't broadcast)
      system.noteBroadcaster.notifyUpdated(existing, source);

      return NextResponse.json({ note: serializeNote(existing) });
    }
  }

  // Create new note
  const invalidTaskNote = validateTaskNoteCreation(type, metadata);
  if (invalidTaskNote) return invalidTaskNote;

  const note = createNote({
    id: noteId ?? `note-${Date.now()}`,
    title: title ?? "Untitled",
    content: content ?? "",
    workspaceId,
    sessionId,
    metadata: {
      type,
      ...metadata,
    },
  });

  await store.save(note, source);

  // Broadcast creation for real-time sync (PgNoteStore/SqliteNoteStore don't broadcast)
  system.noteBroadcaster.notifyCreated(note, source);

  return NextResponse.json({ note: serializeNote(note) }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const noteId = searchParams.get("noteId");
  const workspaceId = searchParams.get("workspaceId");

  if (!noteId) {
    return NextResponse.json({ error: "noteId is required" }, { status: 400 });
  }
  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
  }

  const system = getRoutaSystem();
  await system.noteStore.delete(noteId, workspaceId);

  // Broadcast deletion for real-time sync
  system.noteBroadcaster.notifyDeleted(noteId, workspaceId, "user");

  return NextResponse.json({ deleted: true, noteId });
}

function serializeNote(note: Note) {
  const metadata = Object.fromEntries(
    Object.entries(note.metadata).filter(([, v]) => v != null)
  );
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    workspaceId: note.workspaceId,
    sessionId: note.sessionId,
    metadata,
    createdAt: note.createdAt instanceof Date ? note.createdAt.toISOString() : note.createdAt,
    updatedAt: note.updatedAt instanceof Date ? note.updatedAt.toISOString() : note.updatedAt,
  };
}
