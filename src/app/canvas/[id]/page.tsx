/**
 * Canvas - /canvas/:id
 * Viewer page for opening a saved canvas artifact by ID.
 */
import { Suspense } from "react";

import { CanvasViewerClient } from "./canvas-viewer-client";

export default async function CanvasViewerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <CanvasViewerClient canvasId={id} />
    </Suspense>
  );
}
