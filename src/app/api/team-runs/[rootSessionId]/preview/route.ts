/**
 * Team Run deletion preview — GET /api/team-runs/:rootSessionId/preview
 *
 * Server-computed impact preview shown in the delete confirmation dialog:
 * which agents would be stopped and which sessions / kanban cards /
 * artifacts / worktrees / notes / background tasks would be deleted.
 * Nothing is mutated here.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  buildTeamRunDeletionPlan,
  TeamRunDeletionError,
  type TeamRunDeletionErrorCode,
} from "@/core/orchestration/team-run-deletion";
import { createTeamRunDeletionPorts } from "../../team-run-deletion-ports";

export const dynamic = "force-dynamic";

const ERROR_STATUS: Record<TeamRunDeletionErrorCode, number> = {
  TEAM_RUN_NOT_FOUND: 404,
  TEAM_RUN_NOT_TEAM_ROOT: 409,
  TEAM_RUN_WORKSPACE_MISMATCH: 409,
  TEAM_RUN_RUNNER_UNSUPPORTED: 422,
  TEAM_RUN_STOP_FAILED: 500,
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ rootSessionId: string }> },
) {
  const { rootSessionId } = await params;
  const expectedWorkspaceId = request.nextUrl.searchParams.get("workspaceId") ?? undefined;

  try {
    const plan = await buildTeamRunDeletionPlan(
      createTeamRunDeletionPorts(),
      rootSessionId,
      expectedWorkspaceId,
    );

    return NextResponse.json(
      {
        rootSessionId: plan.rootSessionId,
        teamName: plan.teamName,
        workspaceId: plan.workspaceId,
        counts: {
          sessions: plan.sessionIds.length,
          activeAgents: plan.activeSessionIds.length,
          kanbanCards: plan.kanbanTaskIds.length,
          artifacts: plan.artifactIds.length,
          worktrees: plan.worktrees.length,
          notes: plan.noteIds.length,
          backgroundTasks: plan.backgroundTaskIds.length,
          preservedSharedKanbanCards: plan.sharedKanbanTaskIds.length,
          preservedSharedWorktrees: plan.sharedWorktreeIds.length,
        },
        hasRunnerSessions: plan.runnerSessionIds.length > 0,
        runnerSessionIds: plan.runnerSessionIds,
        sessionIds: plan.sessionIds,
        kanbanTaskIds: plan.kanbanTaskIds,
        sharedKanbanTaskIds: plan.sharedKanbanTaskIds,
        artifactIds: plan.artifactIds,
        worktreeIds: plan.worktrees.map((worktree) => worktree.id),
        sharedWorktreeIds: plan.sharedWorktreeIds,
        noteIds: plan.noteIds,
        backgroundTaskIds: plan.backgroundTaskIds,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof TeamRunDeletionError) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: err.code, message: err.message, details: err.details ?? null },
        },
        { status: ERROR_STATUS[err.code] },
      );
    }
    console.error(`[TeamRuns] Failed to preview team run ${rootSessionId}:`, err);
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: "Failed to preview Team Run deletion" } },
      { status: 500 },
    );
  }
}
