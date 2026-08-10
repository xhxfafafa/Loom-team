/**
 * Shared wiring that connects the Team Run deletion service to the real
 * Next.js server singletons (session store, process manager, stores,
 * kanban broadcaster). Routes stay thin and only translate results/errors
 * to HTTP.
 */

import { getHttpSessionStore } from "@/core/acp/http-session-store";
import { getAcpProcessManager } from "@/core/acp/processer";
import { finalizeSessionRuntime } from "@/core/acp/session-runtime-finalizer";
import { getRoutaSystem } from "@/core/routa-system";
import { getKanbanEventBroadcaster } from "@/core/kanban/kanban-event-broadcaster";
import { GitWorktreeService } from "@/core/git/git-worktree-service";
import { LocalSessionProvider } from "@/core/storage/local-session-provider";
import type { TeamRunDeletionPorts } from "@/core/orchestration/team-run-deletion";

function isServerless(): boolean {
  return !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

export function createTeamRunDeletionPorts(): TeamRunDeletionPorts {
  const sessionStore = getHttpSessionStore();
  const processManager = getAcpProcessManager();
  const system = getRoutaSystem();
  const worktreeService = new GitWorktreeService(system.worktreeStore, system.codebaseStore);

  return {
    async listSessions() {
      // Loads persisted sessions into the in-memory store on first access.
      await sessionStore.hydrateFromDb();
      return sessionStore.listSessions();
    },
    hasActiveProcess: (sessionId) => processManager.hasActiveSession(sessionId),
    // Route Team Run kills through the unified finalizer so history/trace are
    // persisted and MCP proxies are cleaned before the process is terminated.
    killSessionProcess: async (sessionId) => {
      await finalizeSessionRuntime(sessionId, "team-run-delete");
    },
    system,
    clearInMemorySession: (sessionId) => {
      sessionStore.deleteSession(sessionId);
    },
    deleteLocalSessionFile: isServerless()
      ? undefined
      : async (cwd, sessionId) => {
          await new LocalSessionProvider(cwd).delete(sessionId);
        },
    removeWorktreeDirectory: (worktree) => worktreeService.removeWorktreeFilesystem(worktree),
    notifyTaskDeleted: (workspaceId, taskId) => {
      getKanbanEventBroadcaster().notify({
        workspaceId,
        entity: "task",
        action: "deleted",
        resourceId: taskId,
        source: "user",
      });
    },
  };
}
