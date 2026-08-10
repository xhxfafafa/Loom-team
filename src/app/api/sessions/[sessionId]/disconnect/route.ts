import { NextRequest, NextResponse } from "next/server";
import { getHttpSessionStore } from "@/core/acp/http-session-store";
import { finalizeSessionRuntime } from "@/core/acp/session-runtime-finalizer";
import {
  getRequiredRunnerUrl,
  isForwardedAcpRequest,
  proxyRequestToRunner,
  runnerUnavailableResponse,
} from "@/core/acp/runner-routing";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const store = getHttpSessionStore();
  await store.hydrateFromDb();
  const session = store.getSession(sessionId);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (!isForwardedAcpRequest(request) && session.executionMode === "runner") {
    const runnerUrl = getRequiredRunnerUrl();
    if (!runnerUrl) return runnerUnavailableResponse();
    return proxyRequestToRunner(request, {
      runnerUrl,
      path: `/api/sessions/${encodeURIComponent(sessionId)}/disconnect`,
      method: "POST",
    });
  }

  // Unified terminal path: persist history/trace, mark the release reason,
  // kill the provider process + MCP proxy, then clear transient buffers.
  // The durable session record is retained for on-demand recreation.
  const release = await finalizeSessionRuntime(sessionId, "disconnect");

  return NextResponse.json({
    ok: true,
    runtime: {
      released: release.released,
      processTerminated: release.process?.killed ?? false,
      errors: release.errors,
    },
  });
}
