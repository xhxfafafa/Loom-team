/**
 * Team Run card ownership resolution.
 *
 * Kanban cards created by a Team Lead or one of its sub-agent sessions should
 * permanently remember the top-level Team Run that owns them. This module
 * resolves that owning Team Run ID from a card's creating session, using only
 * reliable structural data (the `parentSessionId` tree) — never name-based
 * guessing for ordinary sessions.
 *
 * The resolution rules are intentionally strict:
 * - A Team Run root resolves to its own session ID.
 * - A Team child session walks `parentSessionId` up to its top-level root.
 * - No root, a broken parent chain, a parent outside the same workspace, or a
 *   cycle all resolve to `undefined` (no ownership is assumed).
 *
 * `resolveOwningTeamRunId` is a pure function so it can be unit tested and
 * shared by the MCP tool manager (write path) and the Team Run deletion
 * service (read path).
 */

import { isTeamRunRoot, type TeamRunSessionShape } from "./team-run-identity";

/** Minimal session shape needed for ownership resolution. */
export interface OwnershipSessionShape extends TeamRunSessionShape {
  workspaceId: string;
}

/**
 * Resolve the top-level Team Run session ID that owns the given session.
 *
 * Returns the owning Team Run root session ID, or `undefined` when the session
 * is not part of a resolvable Team Run (normal session, missing session, broken
 * parent chain, cross-workspace parent, or cycle).
 */
export function resolveOwningTeamRunId(
  sessionId: string | undefined,
  allSessions: OwnershipSessionShape[],
): string | undefined {
  if (!sessionId) return undefined;

  const start = allSessions.find((session) => session.sessionId === sessionId);
  if (!start) return undefined;

  // A Team Run never crosses workspace boundaries. Restrict the walk to the
  // session's own workspace so a parent pointing into another workspace is
  // treated as a broken chain rather than followed.
  const sessions = allSessions.filter((session) => session.workspaceId === start.workspaceId);
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));

  const visited = new Set<string>();
  let current = start;
  while (current.parentSessionId) {
    // Cycle guard: we have already passed through this session.
    if (visited.has(current.sessionId)) return undefined;
    visited.add(current.sessionId);

    const parent = byId.get(current.parentSessionId);
    if (!parent) return undefined; // broken chain or cross-workspace parent
    current = parent;
  }

  // `current` is now a top-level session (no parent). It owns the card only if
  // it is actually a Team Run root; ordinary top-level sessions do not.
  return isTeamRunRoot(current, sessions) ? current.sessionId : undefined;
}

/**
 * Convenience wrapper that loads the session list through a port and resolves
 * ownership. Any failure to load sessions resolves to `undefined` so card
 * creation never breaks because of ownership resolution.
 */
export async function resolveOwningTeamRunIdFromSessions(
  sessionId: string | undefined,
  listSessions: () => Promise<OwnershipSessionShape[]> | OwnershipSessionShape[],
): Promise<string | undefined> {
  if (!sessionId) return undefined;
  try {
    const sessions = await listSessions();
    return resolveOwningTeamRunId(sessionId, sessions);
  } catch {
    return undefined;
  }
}
