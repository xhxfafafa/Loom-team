import {
  resolveOwningTeamRunId,
  type OwnershipSessionShape,
} from "../orchestration/team-run-ownership";

export type TeamTaskContext = {
  teamRunId: string;
  codebaseIds: string[];
};

export function withoutClientTeamTaskContext<T extends object>(params: T): Omit<T, "teamRunId" | "codebaseIds"> {
  const safe = { ...params } as T & { teamRunId?: unknown; codebaseIds?: unknown };
  delete safe.teamRunId;
  delete safe.codebaseIds;
  return safe;
}

type CodebaseLookup = {
  findByRepoPath(workspaceId: string, repoPath: string): Promise<{ id: string } | null | undefined>;
};

export async function resolveTeamTaskContext(
  sessionId: string | undefined,
  workspaceId: string,
  listSessions: (() => Promise<OwnershipSessionShape[]> | OwnershipSessionShape[]) | undefined,
  codebaseLookup: CodebaseLookup | undefined,
): Promise<TeamTaskContext | Record<string, never>> {
  if (!sessionId || !listSessions) return {};

  let sessions: OwnershipSessionShape[];
  try {
    sessions = await listSessions();
  } catch {
    return {};
  }

  const teamRunId = resolveOwningTeamRunId(sessionId, sessions);
  if (!teamRunId) return {};

  const cwd = sessions.find((session) => (
    session.sessionId === teamRunId && session.workspaceId === workspaceId
  ))?.cwd?.trim();
  if (!cwd || !codebaseLookup) return { teamRunId, codebaseIds: [] };

  try {
    const codebase = await codebaseLookup.findByRepoPath(workspaceId, cwd);
    return { teamRunId, codebaseIds: codebase ? [codebase.id] : [] };
  } catch {
    return { teamRunId, codebaseIds: [] };
  }
}
