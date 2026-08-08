/**
 * ProductGoalStore — persistence interface for product goals.
 */

import type { ProductGoal, ProductGoalStatus } from "../models/product-goal";

export interface ProductGoalStore {
  save(goal: ProductGoal): Promise<void>;
  get(goalId: string): Promise<ProductGoal | undefined>;
  listByWorkspace(workspaceId: string): Promise<ProductGoal[]>;
  updateStatus(goalId: string, status: ProductGoalStatus): Promise<void>;
  delete(goalId: string): Promise<void>;
}

/**
 * In-memory implementation used by tests and non-persistent runtimes.
 */
export class InMemoryProductGoalStore implements ProductGoalStore {
  private store = new Map<string, ProductGoal>();

  async save(goal: ProductGoal): Promise<void> {
    this.store.set(goal.id, { ...goal });
  }

  async get(goalId: string): Promise<ProductGoal | undefined> {
    const goal = this.store.get(goalId);
    return goal ? { ...goal } : undefined;
  }

  async listByWorkspace(workspaceId: string): Promise<ProductGoal[]> {
    return Array.from(this.store.values())
      .filter((goal) => goal.workspaceId === workspaceId)
      .map((goal) => ({ ...goal }));
  }

  async updateStatus(goalId: string, status: ProductGoalStatus): Promise<void> {
    const goal = this.store.get(goalId);
    if (goal) {
      goal.status = status;
      goal.updatedAt = new Date();
    }
  }

  async delete(goalId: string): Promise<void> {
    this.store.delete(goalId);
  }
}
