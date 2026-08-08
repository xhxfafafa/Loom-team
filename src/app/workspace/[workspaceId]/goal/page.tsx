/**
 * Workspace Goal Page — /workspace/[workspaceId]/goal
 *
 * Server component wrapper for the product goal input form.
 */

import { GoalForm } from "./goal-form";

export async function generateStaticParams() {
  if (process.env.ROUTA_BUILD_STATIC === "1") {
    return [{ workspaceId: "__placeholder__" }];
  }
  return [];
}

export default async function GoalPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ goalId?: string }>;
}) {
  const { workspaceId } = await params;
  const { goalId } = await searchParams;

  return (
    <main className="min-h-screen">
      <GoalForm workspaceId={workspaceId} goalId={goalId ?? null} />
    </main>
  );
}
