/**
 * Workspace / Kanban - /workspace/:workspaceId/kanban
 * Main kanban board for workspace-scoped task coordination, lane automation, and git-aware task execution.
 */
import { KanbanPageClient } from "./kanban-page-client";

export default function WorkspaceKanbanPage() {
  return <KanbanPageClient />;
}
