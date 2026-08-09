import type { TaskInfo } from "../types";

type RepositorySession = { cwd?: string };
type RepositoryCodebase = { id: string; repoPath: string };

/** Resolve only exact Team/root-session repository matches; never guess a default. */
export function resolveTeamCardCodebaseId(
  task: TaskInfo,
  sessionMap: Map<string, RepositorySession>,
  codebases: RepositoryCodebase[],
): string | undefined {
  const repositorySessionId = task.teamRunId ?? task.triggerSessionId;
  const cwd = repositorySessionId ? sessionMap.get(repositorySessionId)?.cwd : undefined;
  if (!cwd) return undefined;
  return codebases.find((codebase) => codebase.repoPath === cwd)?.id;
}
