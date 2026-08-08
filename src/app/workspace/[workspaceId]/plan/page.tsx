/**
 * Workspace Plan Page — /workspace/[workspaceId]/plan
 *
 * Server component wrapper for the plan page.
 */

import { PlanPageClient } from "./plan-page-client";

export async function generateStaticParams() {
  if (process.env.ROUTA_BUILD_STATIC === "1") {
    return [{ workspaceId: "__placeholder__" }];
  }
  return [];
}

export default async function PlanPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return (
    <main className="min-h-screen">
      <PlanPageClient workspaceId={workspaceId} />
    </main>
  );
}
