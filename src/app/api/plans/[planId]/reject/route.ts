/**
 * Dev Plans — POST /api/plans/[planId]/reject
 *
 * Sets status=rejected and appends the user feedback to feedbackLog.
 * A subsequent POST /api/plans with the same goalId (plus the feedback)
 * will generate a new plan taking the feedback into account.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRoutaSystem } from "@/core/routa-system";
import { monitorApiRoute } from "@/core/http/api-route-observability";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ planId: string }> },
) {
  return monitorApiRoute(request, "POST /api/plans/[planId]/reject", async () => {
    const { planId } = await params;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
    if (!feedback) {
      return NextResponse.json(
        { error: "feedback is required" },
        { status: 400 },
      );
    }

    const system = getRoutaSystem();

    const plan = await system.planStore.get(planId);
    if (!plan) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    if (plan.status === "confirmed") {
      return NextResponse.json(
        { error: "Cannot reject a confirmed plan" },
        { status: 409 },
      );
    }

    if (plan.status === "rejected") {
      return NextResponse.json(
        { error: "Plan is already rejected; regenerate instead" },
        { status: 409 },
      );
    }

    const feedbackEntry = { at: new Date().toISOString(), note: feedback };
    await system.planStore.updateStatus(planId, "rejected", { feedbackEntry });

    const updatedPlan = await system.planStore.get(planId);

    return NextResponse.json({ plan: updatedPlan });
  });
}
