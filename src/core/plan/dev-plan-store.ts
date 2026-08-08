/**
 * DevPlanStore — persistence interface for product development plans.
 */

import type { DevPlan, DevPlanStatus } from "./dev-plan";

export interface DevPlanStore {
  save(plan: DevPlan): Promise<void>;
  get(planId: string): Promise<DevPlan | undefined>;
  listByWorkspace(workspaceId: string): Promise<DevPlan[]>;
  listByGoal(goalId: string): Promise<DevPlan[]>;
  updateStatus(
    planId: string,
    status: DevPlanStatus,
    extra?: { confirmedAt?: string; feedbackEntry?: { at: string; note: string } },
  ): Promise<void>;
  delete(planId: string): Promise<void>;
}

/**
 * In-memory implementation used by tests and non-persistent runtimes.
 */
export class InMemoryDevPlanStore implements DevPlanStore {
  private store = new Map<string, DevPlan>();

  async save(plan: DevPlan): Promise<void> {
    this.store.set(plan.id, { ...plan });
  }

  async get(planId: string): Promise<DevPlan | undefined> {
    const plan = this.store.get(planId);
    return plan ? { ...plan } : undefined;
  }

  async listByWorkspace(workspaceId: string): Promise<DevPlan[]> {
    return Array.from(this.store.values())
      .filter((plan) => plan.workspaceId === workspaceId)
      .map((plan) => ({ ...plan }));
  }

  async listByGoal(goalId: string): Promise<DevPlan[]> {
    return Array.from(this.store.values())
      .filter((plan) => plan.goalId === goalId)
      .map((plan) => ({ ...plan }));
  }

  async updateStatus(
    planId: string,
    status: DevPlanStatus,
    extra?: { confirmedAt?: string; feedbackEntry?: { at: string; note: string } },
  ): Promise<void> {
    const plan = this.store.get(planId);
    if (!plan) return;
    plan.status = status;
    plan.updatedAt = new Date().toISOString();
    if (extra?.confirmedAt) {
      plan.confirmedAt = extra.confirmedAt;
    }
    if (extra?.feedbackEntry) {
      plan.feedbackLog = [...plan.feedbackLog, extra.feedbackEntry];
    }
  }

  async delete(planId: string): Promise<void> {
    this.store.delete(planId);
  }
}
