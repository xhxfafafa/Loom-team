/**
 * Product Goals API - /api/goals
 *
 * POST /api/goals - Create a new product goal
 * GET  /api/goals?workspaceId=... - List goals for a workspace
 */

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getRoutaSystem } from "@/core/routa-system";
import { createProductGoal } from "@/core/models/product-goal";
import type {
  ProductGoalRepo,
  ProductGoalRequirementDoc,
} from "@/core/models/product-goal";

export const dynamic = "force-dynamic";

interface CreateGoalBody {
  workspaceId: string;
  goalText: string;
  repos?: ProductGoalRepo[];
  requirementDocs?: ProductGoalRequirementDoc[];
  constraints?: string[];
}

export async function POST(request: NextRequest) {
  let body: CreateGoalBody;
  try {
    body = (await request.json()) as CreateGoalBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.workspaceId || !body.goalText) {
    return NextResponse.json(
      { error: "workspaceId and goalText are required" },
      { status: 400 },
    );
  }

  const system = getRoutaSystem();

  // Verify workspace exists
  const workspace = await system.workspaceStore.get(body.workspaceId);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const goal = createProductGoal({
    id: uuidv4(),
    workspaceId: body.workspaceId,
    goalText: body.goalText,
    repos: body.repos,
    requirementDocs: body.requirementDocs,
    constraints: body.constraints,
  });

  await system.productGoalStore.save(goal);

  return NextResponse.json({ goal }, { status: 201 });
}

export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get("workspaceId");

  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspaceId query parameter is required" },
      { status: 400 },
    );
  }

  const system = getRoutaSystem();
  const goals = await system.productGoalStore.listByWorkspace(workspaceId);

  return NextResponse.json({ goals });
}
