/**
 * PgDevPlanStore — Postgres-backed dev plan store using Drizzle ORM.
 */

import { eq } from "drizzle-orm";
import type { Database } from "./index";
import { devPlans } from "./schema";
import type { DevPlan, DevPlanStatus } from "../plan/dev-plan";
import type { DevPlanStore } from "../plan/dev-plan-store";

export class PgDevPlanStore implements DevPlanStore {
  constructor(private db: Database) {}

  async save(plan: DevPlan): Promise<void> {
    await this.db
      .insert(devPlans)
      .values({
        id: plan.id,
        workspaceId: plan.workspaceId,
        goalId: plan.goalId,
        status: plan.status,
        scope: plan.scope,
        nonGoals: plan.nonGoals,
        risks: plan.risks,
        userStories: plan.userStories,
        technicalApproach: plan.technicalApproach,
        teamAllocation: plan.teamAllocation,
        feedbackLog: plan.feedbackLog,
        confirmedAt: plan.confirmedAt ? new Date(plan.confirmedAt) : null,
        createdAt: new Date(plan.createdAt),
        updatedAt: new Date(plan.updatedAt),
      })
      .onConflictDoUpdate({
        target: devPlans.id,
        set: {
          status: plan.status,
          scope: plan.scope,
          nonGoals: plan.nonGoals,
          risks: plan.risks,
          userStories: plan.userStories,
          technicalApproach: plan.technicalApproach,
          teamAllocation: plan.teamAllocation,
          feedbackLog: plan.feedbackLog,
          confirmedAt: plan.confirmedAt ? new Date(plan.confirmedAt) : null,
          updatedAt: new Date(),
        },
      });
  }

  async get(planId: string): Promise<DevPlan | undefined> {
    const rows = await this.db
      .select()
      .from(devPlans)
      .where(eq(devPlans.id, planId))
      .limit(1);
    return rows[0] ? this.toModel(rows[0]) : undefined;
  }

  async listByWorkspace(workspaceId: string): Promise<DevPlan[]> {
    const rows = await this.db
      .select()
      .from(devPlans)
      .where(eq(devPlans.workspaceId, workspaceId));
    return rows.map(this.toModel);
  }

  async listByGoal(goalId: string): Promise<DevPlan[]> {
    const rows = await this.db
      .select()
      .from(devPlans)
      .where(eq(devPlans.goalId, goalId));
    return rows.map(this.toModel);
  }

  async updateStatus(
    planId: string,
    status: DevPlanStatus,
    extra?: { confirmedAt?: string; feedbackEntry?: { at: string; note: string } },
  ): Promise<void> {
    const existing = await this.get(planId);
    if (!existing) return;
    const feedbackLog = extra?.feedbackEntry
      ? [...existing.feedbackLog, extra.feedbackEntry]
      : existing.feedbackLog;
    const confirmedAt = extra?.confirmedAt
      ? new Date(extra.confirmedAt)
      : existing.confirmedAt
        ? new Date(existing.confirmedAt)
        : null;
    await this.db
      .update(devPlans)
      .set({ status, confirmedAt, feedbackLog, updatedAt: new Date() })
      .where(eq(devPlans.id, planId));
  }

  async delete(planId: string): Promise<void> {
    await this.db.delete(devPlans).where(eq(devPlans.id, planId));
  }

  private toModel(row: typeof devPlans.$inferSelect): DevPlan {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      goalId: row.goalId,
      status: row.status as DevPlanStatus,
      scope: row.scope ?? [],
      nonGoals: row.nonGoals ?? [],
      risks: row.risks ?? [],
      userStories: row.userStories ?? [],
      technicalApproach: row.technicalApproach ?? "",
      teamAllocation: row.teamAllocation ?? [],
      feedbackLog: row.feedbackLog ?? [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : undefined,
    };
  }
}
