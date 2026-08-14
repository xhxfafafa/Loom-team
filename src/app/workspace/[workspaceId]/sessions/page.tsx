/**
 * Workspace / Sessions - /workspace/:workspaceId/sessions
 * Workspace-scoped session index for browsing, filtering, and opening agent execution history.
 */
import { SessionsPageClient } from "./sessions-page-client";

export default function WorkspaceSessionsPage() {
  return <SessionsPageClient />;
}
