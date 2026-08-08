/**
 * Dev Plans API — /api/plans
 *
 * POST /api/plans                      → generate a new plan (status=draft)
 * GET  /api/plans?workspaceId=...      → list plans for a workspace
 */

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getRoutaSystem } from "@/core/routa-system";
import { monitorApiRoute } from "@/core/http/api-route-observability";
import { createDevPlan } from "@/core/plan/dev-plan";
import { generateDevPlanContent } from "@/core/plan/dev-plan-generator";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return monitorApiRoute(request, "POST /api/plans", async () => {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : undefined;
    const goalId = typeof body.goalId === "string" ? body.goalId : undefined;
    const feedback = typeof body.feedback === "string" ? body.feedback : undefined;

    if (!workspaceId || !goalId) {
      return NextResponse.json(
        { error: "workspaceId and goalId are required" },
        { status: 400 },
      );
    }

    const system = getRoutaSystem();

    const workspace = await system.workspaceStore.get(workspaceId);
    if (!workspace) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }

    const goal = await system.productGoalStore.get(goalId);
    if (!goal) {
      return NextResponse.json({ error: "Goal not found" }, { status: 404 });
    }
    if (goal.workspaceId !== workspaceId) {
      return NextResponse.json({ error: "Goal does not belong to workspace" }, { status: 400 });
    }

    const { content, source, fallbackReason } = await generateDevPlanContent({
      goal,
      feedback,
    });

    const plan = createDevPlan({
      id: uuidv4(),
      workspaceId,
      goalId,
      scope: content.scope,
      nonGoals: content.nonGoals,
      risks: content.risks,
      userStories: content.userStories,
      technicalApproach: content.technicalApproach,
      teamAllocation: content.teamAllocation,
    });

    await system.planStore.save(plan);

    return NextResponse.json(
      { plan, source, fallbackReason },
      { status: 201 },
    );
  });
}

export async function GET(request: NextRequest) {
  return monitorApiRoute(request, "GET /api/plans", async () => {
    const workspaceId = request.nextUrl.searchParams.get("workspaceId");
    const goalId = request.nextUrl.searchParams.get("goalId");

    if (!workspaceId && !goalId) {
      return NextResponse.json(
        { error: "workspaceId or goalId query parameter is required" },
        { status: 400 },
      );
    }

    const system = getRoutaSystem();
    let plans;
    if (goalId) {
      plans = await system.planStore.listByGoal(goalId);
    } else {
      plans = await system.planStore.listByWorkspace(workspaceId as string);
    }

    // If filtered by workspace, keep only matching (listByGoal already filters)
    if (workspaceId && !goalId) {
      plans = plans.filter((p) => p.workspaceId === workspaceId);
    }

    return NextResponse.json({ plans });
  });
}
