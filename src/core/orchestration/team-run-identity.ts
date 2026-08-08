/**
 * Team Run identity helpers.
 *
 * A "Team Run" is a top-level Team Lead session together with all of its
 * descendant sessions (the `parentSessionId` tree). This module holds the
 * canonical, server-side rules for recognizing Team Runs and collecting
 * their session trees. All functions are pure so the same rules can be
 * shared by API routes (listing) and domain services (deletion).
 */

export const TEAM_LEAD_SPECIALIST_ID = "team-agent-lead";

/** Minimal session shape needed for Team Run identification. */
export interface TeamRunSessionShape {
  sessionId: string;
  name?: string;
  role?: string;
  specialistId?: string;
  parentSessionId?: string;
}

function normalizeSessionName(name: string | undefined): string {
  return (name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * True when a session carries an explicit Team Run marker: it either uses
 * the Team Lead specialist, or it is a ROUTA session whose name indicates a
 * Team Lead / Team Run.
 */
export function hasExplicitTeamRunMarker(session: TeamRunSessionShape): boolean {
  if (session.specialistId === TEAM_LEAD_SPECIALIST_ID) {
    return true;
  }

  if (session.role?.toUpperCase() !== "ROUTA") {
    return false;
  }

  const normalizedName = normalizeSessionName(session.name);
  if (!normalizedName) {
    return false;
  }

  return (
    normalizedName.startsWith("team -")
    || normalizedName.startsWith("team run")
    || normalizedName.includes("team lead")
  );
}

/** Build a map of parent session ID → direct child sessions. */
export function buildSessionChildMap<T extends TeamRunSessionShape>(sessions: T[]): Map<string, T[]> {
  const childMap = new Map<string, T[]>();
  for (const session of sessions) {
    if (!session.parentSessionId) continue;
    const existing = childMap.get(session.parentSessionId) ?? [];
    existing.push(session);
    childMap.set(session.parentSessionId, existing);
  }
  return childMap;
}

/**
 * Collect the root session ID plus all of its descendants via breadth-first
 * traversal. Cycle-safe: a session is visited at most once.
 *
 * Returns session IDs with the root first.
 */
export function collectTeamSessionIds<T extends TeamRunSessionShape>(
  rootSessionId: string,
  sessions: T[],
): string[] {
  const childMap = buildSessionChildMap(sessions);
  const collected: string[] = [];
  const visited = new Set<string>([rootSessionId]);
  const queue: string[] = [rootSessionId];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    collected.push(current);
    for (const child of childMap.get(current) ?? []) {
      if (visited.has(child.sessionId)) continue;
      visited.add(child.sessionId);
      queue.push(child.sessionId);
    }
  }

  return collected;
}

/** Count descendant sessions (excluding the root itself). Cycle-safe. */
export function countDescendantSessions<T extends TeamRunSessionShape>(
  rootSessionId: string,
  sessions: T[],
): number {
  return collectTeamSessionIds(rootSessionId, sessions).length - 1;
}

/**
 * True when the session is a Team Run root: a top-level session (no parent)
 * that is either explicitly marked as a Team Run, or a ROUTA session that has
 * at least one descendant. This mirrors what the team surface lists.
 */
export function isTeamRunRoot<T extends TeamRunSessionShape>(session: T, allSessions: T[]): boolean {
  if (session.parentSessionId) {
    return false;
  }

  if (hasExplicitTeamRunMarker(session)) {
    return true;
  }

  return session.role?.toUpperCase() === "ROUTA"
    && countDescendantSessions(session.sessionId, allSessions) > 0;
}
