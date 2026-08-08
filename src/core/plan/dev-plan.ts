/**
 * DevPlan model
 *
 * First-class structured product development plan derived from a ProductGoal.
 * Captures scope, non-goals, risks, user stories (with acceptance criteria),
 * technical approach, team allocation, and a feedback log for review cycles.
 *
 * Status flow:
 *   draft → confirmed   (programmatic confirmation gate; triggers decomposition)
 *   draft → rejected    (user rejects with feedback; may regenerate)
 *   rejected → draft    (regeneration taking feedback into account)
 */

export type DevPlanStatus = "draft" | "confirmed" | "rejected";

export interface DevPlanRisk {
  risk: string;
  mitigation?: string;
}

export interface DevPlanUserStory {
  id: string;
  title: string;
  story: string;
  acceptanceCriteria: string[];
}

export interface DevPlanTeamAllocation {
  role: string;
  responsibility: string;
}

export interface DevPlanFeedbackEntry {
  at: string; // ISO 8601
  note: string;
}

export interface DevPlan {
  id: string;
  workspaceId: string;
  goalId: string;
  status: DevPlanStatus;
  scope: string[];
  nonGoals: string[];
  risks: DevPlanRisk[];
  userStories: DevPlanUserStory[];
  technicalApproach: string;
  teamAllocation: DevPlanTeamAllocation[];
  feedbackLog: DevPlanFeedbackEntry[];
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  confirmedAt?: string; // ISO 8601
}

export interface CreateDevPlanParams {
  id: string;
  workspaceId: string;
  goalId: string;
  status?: DevPlanStatus;
  scope?: string[];
  nonGoals?: string[];
  risks?: DevPlanRisk[];
  userStories?: DevPlanUserStory[];
  technicalApproach?: string;
  teamAllocation?: DevPlanTeamAllocation[];
  feedbackLog?: DevPlanFeedbackEntry[];
  confirmedAt?: string;
}

export function createDevPlan(params: CreateDevPlanParams): DevPlan {
  const now = new Date().toISOString();
  return {
    id: params.id,
    workspaceId: params.workspaceId,
    goalId: params.goalId,
    status: params.status ?? "draft",
    scope: params.scope ?? [],
    nonGoals: params.nonGoals ?? [],
    risks: params.risks ?? [],
    userStories: params.userStories ?? [],
    technicalApproach: params.technicalApproach ?? "",
    teamAllocation: params.teamAllocation ?? [],
    feedbackLog: params.feedbackLog ?? [],
    createdAt: now,
    updatedAt: now,
    confirmedAt: params.confirmedAt,
  };
}
