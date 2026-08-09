/**
 * /api/tasks/unassigned — unassigned historical kanban cards.
 *
 * GET    /api/tasks/unassigned?workspaceId=...  → list/count the workspace
 *          cards that carry no explicit team-run ownership and are not
 *          linked into any existing Team Run session tree. Read-only.
 * DELETE /api/tasks/unassigned?workspaceId=...  → delete exactly those
 *          cards. Requires the JSON body { "confirm": "DELETE" }. Only card
 *          records are removed — codebases, repositories, worktrees,
 *          artifacts, notes and sessions are never touched.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  deleteUnassignedHistoricalCards,
  previewUnassignedHistoricalCards,
} from "@/core/orchestration/unassigned-team-cards";
import { createUnassignedCardsPorts } from "../unassigned-cards-ports";

export const dynamic = "force-dynamic";

/** Confirmation token the DELETE body must carry verbatim. */
export const UNASSIGNED_CARDS_DELETE_CONFIRM_TOKEN = "DELETE";

function missingWorkspaceResponse() {
  return NextResponse.json(
    {
      ok: false,
      error: { code: "WORKSPACE_ID_REQUIRED", message: "workspaceId query parameter is required" },
    },
    { status: 400 },
  );
}

export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get("workspaceId");
  if (!workspaceId) return missingWorkspaceResponse();

  try {
    const preview = await previewUnassignedHistoricalCards(
      createUnassignedCardsPorts(),
      workspaceId,
    );
    return NextResponse.json(
      {
        workspaceId: preview.workspaceId,
        count: preview.taskIds.length,
        taskIds: preview.taskIds,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error(`[Tasks] Failed to preview unassigned cards for ${workspaceId}:`, err);
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: "Failed to preview unassigned cards" } },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get("workspaceId");
  if (!workspaceId) return missingWorkspaceResponse();

  let confirm: unknown;
  try {
    const body = (await request.json()) as { confirm?: unknown };
    confirm = body?.confirm;
  } catch {
    confirm = undefined;
  }
  if (confirm !== UNASSIGNED_CARDS_DELETE_CONFIRM_TOKEN) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "CONFIRMATION_REQUIRED",
          message: `Body must include { "confirm": "${UNASSIGNED_CARDS_DELETE_CONFIRM_TOKEN}" }`,
        },
      },
      { status: 400 },
    );
  }

  try {
    const result = await deleteUnassignedHistoricalCards(
      createUnassignedCardsPorts(),
      workspaceId,
    );
    return NextResponse.json({
      workspaceId: result.workspaceId,
      deletedCount: result.deletedTaskIds.length,
      deletedTaskIds: result.deletedTaskIds,
    });
  } catch (err) {
    console.error(`[Tasks] Failed to delete unassigned cards for ${workspaceId}:`, err);
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: "Failed to delete unassigned cards" } },
      { status: 500 },
    );
  }
}
