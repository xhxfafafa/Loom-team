/**
 * Dev Plans — POST /api/plans/[planId]/confirm
 *
 * Programmatic confirmation gate. Sets status=confirmed + confirmedAt,
 * then decomposes userStories onto the default kanban board as tasks.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRoutaSystem } from "@/core/routa-system";
import { monitorApiRoute } from "@/core/http/api-route-observability";
import { decomposePlanToTasks } from "@/core/plan/decompose-plan";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ planId: string }> },
) {
  return monitorApiRoute(request, "POST /api/plans/[planId]/confirm", async () => {
    const { planId } = await params;
    const system = getRoutaSystem();

    const plan = await system.planStore.get(planId);
    if (!plan) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    if (plan.status === "confirmed") {
      return NextResponse.json(
        { error: "Plan is already confirmed" },
        { status: 409 },
      );
    }

    if (plan.status === "rejected") {
      return NextResponse.json(
        { error: "Cannot confirm a rejected plan; regenerate instead" },
        { status: 409 },
      );
    }

    const confirmedAt = new Date().toISOString();
    await system.planStore.updateStatus(planId, "confirmed", { confirmedAt });

    let decomposition;
    try {
      const fresh = (await system.planStore.get(planId)) ?? plan;
      decomposition = await decomposePlanToTasks(system, fresh);
    } catch (err) {
      return NextResponse.json(
        {
          error: "Plan confirmed but task decomposition failed",
          detail: err instanceof Error ? err.message : String(err),
          confirmedAt,
        },
        { status: 500 },
      );
    }

    const confirmedPlan = await system.planStore.get(planId);

    return NextResponse.json({
      plan: confirmedPlan,
      decomposition,
    });
  });
}
