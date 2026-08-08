/**
 * Team Run deletion API — DELETE /api/team-runs/:rootSessionId
 *
 * Deletes a Team Run (top-level Team Lead session) and all data that belongs
 * exclusively to its session tree. Never deletes arbitrary sessions — the
 * target must be a Team Run root, and all ownership rules are enforced
 * server-side (see src/core/orchestration/team-run-deletion.ts).
 *
 * This endpoint intentionally does NOT reuse DELETE /api/sessions/:id so the
 * Team safety boundaries cannot be bypassed.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  deleteTeamRun,
  TeamRunDeletionError,
  type TeamRunDeletionErrorCode,
} from "@/core/orchestration/team-run-deletion";
import { createTeamRunDeletionPorts } from "../team-run-deletion-ports";

export const dynamic = "force-dynamic";

const ERROR_STATUS: Record<TeamRunDeletionErrorCode, number> = {
  TEAM_RUN_NOT_FOUND: 404,
  TEAM_RUN_NOT_TEAM_ROOT: 409,
  TEAM_RUN_WORKSPACE_MISMATCH: 409,
  TEAM_RUN_RUNNER_UNSUPPORTED: 422,
  TEAM_RUN_STOP_FAILED: 500,
};

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ rootSessionId: string }> },
) {
  const { rootSessionId } = await params;

  // Optional client-side workspace guard. The authoritative workspace always
  // comes from the server-side session record.
  let expectedWorkspaceId: string | undefined;
  const workspaceIdParam = request.nextUrl.searchParams.get("workspaceId");
  if (workspaceIdParam) {
    expectedWorkspaceId = workspaceIdParam;
  } else {
    try {
      const body = (await request.json()) as { workspaceId?: unknown };
      if (typeof body?.workspaceId === "string" && body.workspaceId) {
        expectedWorkspaceId = body.workspaceId;
      }
    } catch {
      // Body is optional; ignore parse errors.
    }
  }

  if (!expectedWorkspaceId) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "TEAM_RUN_WORKSPACE_REQUIRED",
          message: "workspaceId is required to delete a Team Run",
        },
      },
      { status: 400 },
    );
  }

  try {
    const result = await deleteTeamRun(
      createTeamRunDeletionPorts(),
      rootSessionId,
      expectedWorkspaceId,
    );
    return NextResponse.json({ ok: true, result });
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
    console.error(`[TeamRuns] Failed to delete team run ${rootSessionId}:`, err);
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: "Failed to delete Team Run" } },
      { status: 500 },
    );
  }
}
