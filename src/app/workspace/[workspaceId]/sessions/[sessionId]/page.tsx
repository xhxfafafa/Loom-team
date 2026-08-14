/**
 * Workspace Session Page (Server Component Wrapper)
 *
 * This server component renders the client component.
 *
 * Route: /workspace/[workspaceId]/sessions/[sessionId]
 */

import { Suspense } from "react";
import { SessionPageClient } from "./session-page-client";

export default function WorkspaceSessionPage() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center">Loading...</div>}>
      <SessionPageClient />
    </Suspense>
  );
}
