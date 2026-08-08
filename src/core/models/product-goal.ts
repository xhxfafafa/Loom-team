/**
 * Product Goal model
 *
 * First-class structured input for workspace product goals.
 * Captures the user's product intent including goal description,
 * associated repositories, requirement documents, and technical constraints.
 */

export type ProductGoalStatus = "draft" | "active";

export interface ProductGoalRepo {
  kind: "local" | "github";
  path?: string;
  url?: string;
}

export interface ProductGoalRequirementDoc {
  name: string;
  content: string;
}

export interface ProductGoal {
  id: string;
  workspaceId: string;
  goalText: string;
  repos: ProductGoalRepo[];
  requirementDocs: ProductGoalRequirementDoc[];
  constraints: string[];
  status: ProductGoalStatus;
  createdAt: Date;
  updatedAt: Date;
}

export function createProductGoal(params: {
  id: string;
  workspaceId: string;
  goalText: string;
  repos?: ProductGoalRepo[];
  requirementDocs?: ProductGoalRequirementDoc[];
  constraints?: string[];
  status?: ProductGoalStatus;
}): ProductGoal {
  const now = new Date();
  return {
    id: params.id,
    workspaceId: params.workspaceId,
    goalText: params.goalText,
    repos: params.repos ?? [],
    requirementDocs: params.requirementDocs ?? [],
    constraints: params.constraints ?? [],
    status: params.status ?? "draft",
    createdAt: now,
    updatedAt: now,
  };
}
