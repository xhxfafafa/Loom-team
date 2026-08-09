/**
 * Shared wiring that connects the unassigned historical card service to the
 * real Next.js server singletons (session store, task store, kanban
 * broadcaster). Routes stay thin and only translate results/errors to HTTP.
 */

import { getHttpSessionStore } from "@/core/acp/http-session-store";
import { getRoutaSystem } from "@/core/routa-system";
import { getKanbanEventBroadcaster } from "@/core/kanban/kanban-event-broadcaster";
import type { UnassignedCardsPorts } from "@/core/orchestration/unassigned-team-cards";

export function createUnassignedCardsPorts(): UnassignedCardsPorts {
  const sessionStore = getHttpSessionStore();
  const system = getRoutaSystem();

  return {
    async listSessions() {
      // Loads persisted sessions into the in-memory store on first access.
      await sessionStore.hydrateFromDb();
      return sessionStore.listSessions();
    },
    taskStore: system.taskStore,
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
