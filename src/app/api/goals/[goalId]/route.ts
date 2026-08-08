/**
 * Product Goal API - /api/goals/[goalId]
 *
 * GET /api/goals/[goalId] - Get a specific goal
 * PUT /api/goals/[goalId] - Update a goal
 */

import { NextRequest, NextResponse } from "next/server";
import { getRoutaSystem } from "@/core/routa-system";
import type {
  ProductGoalRepo,
  ProductGoalRequirementDoc,
  ProductGoalStatus,
} from "@/core/models/product-goal";

export const dynamic = "force-dynamic";

interface UpdateGoalBody {
  goalText?: string;
  repos?: ProductGoalRepo[];
  requirementDocs?: ProductGoalRequirementDoc[];
  constraints?: string[];
  status?: ProductGoalStatus;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ goalId: string }> },
) {
  const { goalId } = await params;
  const system = getRoutaSystem();
  const goal = await system.productGoalStore.get(goalId);

  if (!goal) {
    return NextResponse.json({ error: "Goal not found" }, { status: 404 });
  }

  return NextResponse.json({ goal });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ goalId: string }> },
) {
  const { goalId } = await params;

  let body: UpdateGoalBody;
  try {
    body = (await request.json()) as UpdateGoalBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const system = getRoutaSystem();
  const existing = await system.productGoalStore.get(goalId);

  if (!existing) {
    return NextResponse.json({ error: "Goal not found" }, { status: 404 });
  }

  const updated = {
    ...existing,
    goalText: body.goalText ?? existing.goalText,
    repos: body.repos ?? existing.repos,
    requirementDocs: body.requirementDocs ?? existing.requirementDocs,
    constraints: body.constraints ?? existing.constraints,
    status: body.status ?? existing.status,
    updatedAt: new Date(),
  };

  await system.productGoalStore.save(updated);

  return NextResponse.json({ goal: updated });
}
