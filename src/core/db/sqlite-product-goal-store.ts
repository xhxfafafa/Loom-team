/**
 * SqliteProductGoalStore — SQLite-backed product goal store using Drizzle ORM.
 */

import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as sqliteSchema from "./sqlite-schema";
import type { ProductGoal, ProductGoalStatus } from "../models/product-goal";
import type { ProductGoalStore } from "../store/product-goal-store";

type SqliteDb = BetterSQLite3Database<typeof sqliteSchema>;

export class SqliteProductGoalStore implements ProductGoalStore {
  constructor(private db: SqliteDb) {}

  async save(goal: ProductGoal): Promise<void> {
    await this.db
      .insert(sqliteSchema.productGoals)
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
        target: sqliteSchema.productGoals.id,
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
      .from(sqliteSchema.productGoals)
      .where(eq(sqliteSchema.productGoals.id, goalId))
      .limit(1);
    return rows[0] ? this.toModel(rows[0]) : undefined;
  }

  async listByWorkspace(workspaceId: string): Promise<ProductGoal[]> {
    const rows = await this.db
      .select()
      .from(sqliteSchema.productGoals)
      .where(eq(sqliteSchema.productGoals.workspaceId, workspaceId));
    return rows.map(this.toModel);
  }

  async updateStatus(goalId: string, status: ProductGoalStatus): Promise<void> {
    await this.db
      .update(sqliteSchema.productGoals)
      .set({ status, updatedAt: new Date() })
      .where(eq(sqliteSchema.productGoals.id, goalId));
  }

  async delete(goalId: string): Promise<void> {
    await this.db.delete(sqliteSchema.productGoals).where(eq(sqliteSchema.productGoals.id, goalId));
  }

  private toModel(row: typeof sqliteSchema.productGoals.$inferSelect): ProductGoal {
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
