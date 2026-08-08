/**
 * Dev Plans — GET /api/plans/[planId]
 */

import { NextRequest, NextResponse } from "next/server";
import { getRoutaSystem } from "@/core/routa-system";
import { monitorApiRoute } from "@/core/http/api-route-observability";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ planId: string }> },
) {
  return monitorApiRoute(request, "GET /api/plans/[planId]", async () => {
    const { planId } = await params;
    const system = getRoutaSystem();
    const plan = await system.planStore.get(planId);

    if (!plan) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    return NextResponse.json({ plan });
  });
}
