/**
 * Sessions REST API Route - /api/sessions
 *
 * Lists ACP sessions created via /api/acp for the browser UI.
 * This is NOT part of ACP; it's only for the web dashboard.
 */

import { NextRequest, NextResponse } from "next/server";
import { getHttpSessionStore, type RoutaSessionRecord } from "@/core/acp/http-session-store";
import { getAcpProcessManager } from "@/core/acp/processer";
import { getPresetById } from "@/core/acp/acp-presets";
import {
  buildSessionChildMap,
  countDescendantSessions,
  hasExplicitTeamRunMarker,
} from "@/core/orchestration/team-run-identity";

export const dynamic = "force-dynamic";

/** Stale threshold: sessions older than 7 days without an active process are considered stale */
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionContinuityStatus = "active" | "interrupted" | "restorable" | "stale";

interface TeamRunSummary {
  session: RoutaSessionRecord;
  directDelegates: number;
  descendants: number;
}

/**
 * Derive the session continuity status for the session picker UI.
 */
function deriveSessionStatus(session: RoutaSessionRecord, hasActiveProcess: boolean): SessionContinuityStatus {
  if (hasActiveProcess || session.acpStatus === "ready" || session.acpStatus === "connecting") {
    return "active";
  }

  const createdAt = typeof session.createdAt === "string" ? new Date(session.createdAt).getTime() : Date.now();
  const age = Date.now() - createdAt;
  if (age > STALE_THRESHOLD_MS) {
    return "stale";
  }

  const preset = getPresetById(session.provider ?? "");
  if (preset?.resume?.supported) {
    return "restorable";
  }

  return "interrupted";
}

function toSessionSummary(session: RoutaSessionRecord, hasActiveProcess: boolean) {
  const preset = getPresetById(session.provider ?? "");
  return {
    sessionId: session.sessionId,
    name: session.name,
    cwd: session.cwd,
    branch: session.branch,
    workspaceId: session.workspaceId,
    routaAgentId: session.routaAgentId,
    provider: session.provider,
    role: session.role,
    acpStatus: session.acpStatus,
    acpError: session.acpError,
    modeId: session.modeId,
    model: session.model,
    parentSessionId: session.parentSessionId,
    specialistId: session.specialistId,
    createdAt: session.createdAt,
    continuityStatus: deriveSessionStatus(session, hasActiveProcess),
    resumeCapabilities: preset?.resume ?? null,
  };
}

function listTeamRuns(sessions: RoutaSessionRecord[]): TeamRunSummary[] {
  const childMap = buildSessionChildMap(sessions);

  return sessions
    .filter((session) => !session.parentSessionId)
    .map((session) => {
      const directDelegates = (childMap.get(session.sessionId) ?? []).length;
      const descendants = countDescendantSessions(session.sessionId, sessions);
      return { session, directDelegates, descendants };
    })
    .filter(({ session, descendants }) => {
      if (hasExplicitTeamRunMarker(session)) {
        return true;
      }

      return session.role?.toUpperCase() === "ROUTA" && descendants > 0;
    });
}

export async function GET(request: NextRequest) {
  const store = getHttpSessionStore();
  const processManager = getAcpProcessManager();

  // Hydrate from database on first access (loads persisted sessions)
  await store.hydrateFromDb();

  const workspaceId = request.nextUrl.searchParams.get("workspaceId");
  const parentSessionId = request.nextUrl.searchParams.get("parentSessionId");
  const surface = request.nextUrl.searchParams.get("surface");
  const rawLimit = request.nextUrl.searchParams.get("limit");
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : Number.NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null;

  const summarize = (s: RoutaSessionRecord) => toSessionSummary(s, processManager.hasActiveSession(s.sessionId));

  let sessions = store.listSessions();
  if (workspaceId) {
    sessions = sessions.filter((s) => s.workspaceId === workspaceId);
  }

  // Filter by parent session ID — used to restore CRAFTER state on page reload
  if (parentSessionId) {
    sessions = sessions.filter((s) => s.parentSessionId === parentSessionId);
    // When querying children, include sessions that haven't sent a prompt yet
    return NextResponse.json(
      { sessions: (limit ? sessions.slice(0, limit) : sessions).map(summarize) },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  // Filter out empty sessions that never received a real prompt
  sessions = sessions.filter((s) => s.firstPromptSent !== false);

  if (surface === "team") {
    const teamRuns = listTeamRuns(sessions);
    return NextResponse.json(
      {
        sessions: (limit ? teamRuns.slice(0, limit) : teamRuns).map(({ session, directDelegates, descendants }) => ({
          ...summarize(session),
          directDelegates,
          descendants,
        })),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    { sessions: (limit ? sessions.slice(0, limit) : sessions).map(summarize) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
