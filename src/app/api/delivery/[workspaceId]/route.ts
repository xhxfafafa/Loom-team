/**
 * GET /api/delivery/[workspaceId]
 *
 * Thin route handler for the Final Delivery View.
 * All logic lives in src/core/delivery/delivery-report.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { monitorApiRoute } from "@/core/http/api-route-observability";
import { getRoutaSystem } from "@/core/routa-system";
import { buildDeliveryReport } from "@/core/delivery/delivery-report";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  return monitorApiRoute(request, "GET /api/delivery/[workspaceId]", async () => {
    const { workspaceId } = await params;

    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspaceId is required" },
        { status: 400 },
      );
    }

    const system = getRoutaSystem();

    try {
      const report = await buildDeliveryReport({
        workspaceId,
        taskStore: system.taskStore,
        artifactStore: system.artifactStore,
        codebaseStore: system.codebaseStore,
      });
      return NextResponse.json(report);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json(
        { error: `Failed to build delivery report: ${message}` },
        { status: 500 },
      );
    }
  });
}
