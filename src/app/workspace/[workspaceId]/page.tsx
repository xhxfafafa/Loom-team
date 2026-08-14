/**
 * Workspace Page (Server Component Wrapper)
 *
 * This server component redirects the workspace root to the canonical
 * Kanban work surface.
 *
 * Route: /workspace/[workspaceId]
 */

import { redirect } from "next/navigation";

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/workspace/${workspaceId}/kanban`);
}
