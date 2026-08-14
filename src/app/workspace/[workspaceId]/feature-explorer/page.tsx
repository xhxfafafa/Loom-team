import { FeatureExplorerPageClient } from "./feature-explorer-page-client";

export default async function FeatureExplorerPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <FeatureExplorerPageClient workspaceId={workspaceId} />;
}
