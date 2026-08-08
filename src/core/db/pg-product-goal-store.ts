/**
 * PgProductGoalStore — Postgres-backed product goal store using Drizzle ORM.
 */

import { eq } from "drizzle-orm";
import type { Database } from "./index";
import { productGoals } from "./schema";
import type { ProductGoal, ProductGoalStatus } from "../models/product-goal";
import type { ProductGoalStore } from "../store/product-goal-store";

export class PgProductGoalStore implements ProductGoalStore {
  constructor(private db: Database) {}

  async save(goal: ProductGoal): Promise<void> {
    await this.db
      .insert(productGoals)
      .values({
        id: goal.id,
        workspaceId: goal.workspaceId,
        goalText: goal.goalText,
        repos: goal.repos,
        requirementDocs: goal.requirementDocs,
        constraints: goal.constraints,
        status: goal.status,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
      })
      .onConflictDoUpdate({
        target: productGoals.id,
        set: {
          goalText: goal.goalText,
          repos: goal.repos,
          requirementDocs: goal.requirementDocs,
          constraints: goal.constraints,
          status: goal.status,
          updatedAt: new Date(),
        },
      });
  }

  async get(goalId: string): Promise<ProductGoal | undefined> {
    const rows = await this.db
      .select()
      .from(productGoals)
      .where(eq(productGoals.id, goalId))
      .limit(1);
    return rows[0] ? this.toModel(rows[0]) : undefined;
  }

  async listByWorkspace(workspaceId: string): Promise<ProductGoal[]> {
    const rows = await this.db
      .select()
      .from(productGoals)
      .where(eq(productGoals.workspaceId, workspaceId));
    return rows.map(this.toModel);
  }

  async updateStatus(goalId: string, status: ProductGoalStatus): Promise<void> {
    await this.db
      .update(productGoals)
      .set({ status, updatedAt: new Date() })
      .where(eq(productGoals.id, goalId));
  }

  async delete(goalId: string): Promise<void> {
    await this.db.delete(productGoals).where(eq(productGoals.id, goalId));
  }

  private toModel(row: typeof productGoals.$inferSelect): ProductGoal {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      goalText: row.goalText,
      repos: row.repos ?? [],
      requirementDocs: row.requirementDocs ?? [],
      constraints: row.constraints ?? [],
      status: row.status as ProductGoalStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
