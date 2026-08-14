import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleSessionNew: vi.fn(),
  dispatchSessionPrompt: vi.fn(),
  pushNotification: vi.fn(),
  getConsolidatedHistory: vi.fn(),
  killSession: vi.fn(),
}));

vi.mock("../../../acp/acp-session-create", () => ({
  handleSessionNew: mocks.handleSessionNew,
}));

vi.mock("@/core/acp/session-prompt", () => ({
  dispatchSessionPrompt: mocks.dispatchSessionPrompt,
}));

vi.mock("@/core/acp/http-session-store", () => ({
  getHttpSessionStore: () => ({
    pushNotification: mocks.pushNotification,
    getConsolidatedHistory: mocks.getConsolidatedHistory,
  }),
}));

vi.mock("@/core/acp/processer", () => ({
  getAcpProcessManager: () => ({ killSession: mocks.killSession }),
}));

import { GET } from "../route";

const tempRoots: string[] = [];

function makeTempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-instructions-route-"));
  tempRoots.push(root);
  return root;
}

function get(url: string): Promise<Response> {
  return GET(new NextRequest(url));
}

function jsonRpcSuccess(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, result }), {
    headers: { "Content-Type": "application/json" },
  });
}

function jsonRpcError(message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }),
    { headers: { "Content-Type": "application/json" } },
  );
}

const auditPayload = {
  audit_conclusion: {
    overall: "有条件通过",
    total_score: 14,
    one_sentence: "整体可用，仍需补充验证步骤。",
  },
  principles: {
    routing: { score: 4 },
    protection: { score: 3 },
    reflection: { score: 3 },
    verification: { score: 4 },
  },
};

beforeEach(() => {
  mocks.handleSessionNew.mockReset();
  mocks.dispatchSessionPrompt.mockReset();
  mocks.pushNotification.mockReset();
  mocks.getConsolidatedHistory.mockReset();
  mocks.killSession.mockReset();
  mocks.killSession.mockResolvedValue(undefined);
  mocks.dispatchSessionPrompt.mockResolvedValue(undefined);
});

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("GET /api/harness/instructions", () => {
  it("returns 404 when no guidance document exists", async () => {
    const root = makeTempRepo();
    const res = await get(
      `http://localhost/api/harness/instructions?repoPath=${encodeURIComponent(root)}`,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("未找到仓库指导文档");
    expect(body.details).toContain("CLAUDE.md");
    expect(body.details).toContain("AGENTS.md");
  });

  it("returns 400 when repoPath is not a directory", async () => {
    const res = await get(
      "http://localhost/api/harness/instructions?repoPath=/definitely/not/a/dir",
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Harness 指导文档上下文无效");
  });

  it("serves CLAUDE.md without an audit by default", async () => {
    const root = makeTempRepo();
    const source = "# Team guidance\n\nDo not skip verification.\n";
    fs.writeFileSync(path.join(root, "CLAUDE.md"), source, "utf8");

    const res = await get(
      `http://localhost/api/harness/instructions?repoPath=${encodeURIComponent(root)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fileName).toBe("CLAUDE.md");
    expect(body.relativePath).toBe("CLAUDE.md");
    expect(body.fallbackUsed).toBe(false);
    expect(body.source).toBe(source);
    expect(body.repoRoot).toBe(root);
    expect(body.audit).toBeNull();
    expect(mocks.handleSessionNew).not.toHaveBeenCalled();
  });

  it("falls back to AGENTS.md when CLAUDE.md is missing", async () => {
    const root = makeTempRepo();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents guidance\n", "utf8");

    const res = await get(
      `http://localhost/api/harness/instructions?repoPath=${encodeURIComponent(root)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fileName).toBe("AGENTS.md");
    expect(body.fallbackUsed).toBe(true);
  });

  it("runs the Web ACP audit when includeAudit is enabled", async () => {
    const root = makeTempRepo();
    const source = "# Team guidance\n\nAlways run lint before PR.\n";
    fs.writeFileSync(path.join(root, "CLAUDE.md"), source, "utf8");

    mocks.handleSessionNew.mockResolvedValue(
      jsonRpcSuccess({ sessionId: "sess-audit-1", provider: "claude" }),
    );
    mocks.getConsolidatedHistory.mockReturnValue([
      { update: { sessionUpdate: "agent_plan", content: { text: "plan" } } },
      {
        update: {
          sessionUpdate: "agent_message",
          content: { text: JSON.stringify(auditPayload) },
        },
      },
    ]);

    const res = await get(
      `http://localhost/api/harness/instructions?repoPath=${encodeURIComponent(root)}&includeAudit=1&auditProvider=claude`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.audit).toMatchObject({
      status: "ok",
      provider: "claude",
      totalScore: 14,
      overall: "有条件通过",
      oneSentence: "整体可用，仍需补充验证步骤。",
      principles: { routing: 4, protection: 3, reflection: 3, verification: 4 },
    });
    expect(typeof body.audit.durationMs).toBe("number");
    expect(typeof body.audit.generatedAt).toBe("string");

    expect(mocks.handleSessionNew).toHaveBeenCalledTimes(1);
    const createArgs = mocks.handleSessionNew.mock.calls[0][0];
    expect(createArgs.params).toMatchObject({
      workspaceId: "default",
      provider: "claude",
      specialistId: "agents-md-auditor",
      specialistLocale: "en",
      cwd: root,
      name: "Harness instruction audit",
    });

    expect(mocks.dispatchSessionPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchSessionPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-audit-1",
        workspaceId: "default",
        provider: "claude",
        cwd: root,
        prompt: source,
      }),
    );

    expect(mocks.killSession).toHaveBeenCalledWith("sess-audit-1");
  });

  it("maps legacy codex provider names onto the Web provider fallback", async () => {
    const root = makeTempRepo();
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Guidance\n", "utf8");

    mocks.handleSessionNew.mockResolvedValue(
      jsonRpcSuccess({ sessionId: "sess-audit-2", provider: "opencode" }),
    );
    mocks.getConsolidatedHistory.mockReturnValue([
      {
        update: {
          sessionUpdate: "agent_message",
          content: { text: JSON.stringify(auditPayload) },
        },
      },
    ]);

    const res = await get(
      `http://localhost/api/harness/instructions?repoPath=${encodeURIComponent(root)}&includeAudit=true&auditProvider=codex`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    const createArgs = mocks.handleSessionNew.mock.calls[0][0];
    expect(createArgs.params.provider).toBeUndefined();
    expect(body.audit.status).toBe("ok");
    expect(body.audit.provider).toBe("opencode");
  });

  it("falls back to the heuristic audit when session creation fails", async () => {
    const root = makeTempRepo();
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Guidance\nDo not force push.\n", "utf8");

    mocks.handleSessionNew.mockRejectedValue(new Error("acp unavailable"));

    const res = await get(
      `http://localhost/api/harness/instructions?repoPath=${encodeURIComponent(root)}&includeAudit=1`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audit.status).toBe("heuristic");
    expect(body.audit.error).toContain("acp unavailable");
    expect(body.audit.oneSentence).toContain("启发式评分");
    expect(body.audit.provider).toBe("codex");
    expect(typeof body.audit.totalScore).toBe("number");
    expect(body.audit.principles).toEqual(
      expect.objectContaining({
        routing: expect.any(Number),
        protection: expect.any(Number),
        reflection: expect.any(Number),
        verification: expect.any(Number),
      }),
    );
    expect(mocks.killSession).not.toHaveBeenCalled();
  });

  it("falls back to the heuristic audit when the JSON-RPC result is an error", async () => {
    const root = makeTempRepo();
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Guidance\n", "utf8");

    mocks.handleSessionNew.mockResolvedValue(jsonRpcError("workspace unavailable"));

    const res = await get(
      `http://localhost/api/harness/instructions?repoPath=${encodeURIComponent(root)}&includeAudit=1`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audit.status).toBe("heuristic");
    expect(body.audit.error).toContain("workspace unavailable");
    expect(mocks.killSession).not.toHaveBeenCalled();
  });

  it("falls back to the heuristic audit when the agent output is not JSON", async () => {
    const root = makeTempRepo();
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Guidance\n", "utf8");

    mocks.handleSessionNew.mockResolvedValue(
      jsonRpcSuccess({ sessionId: "sess-audit-3", provider: "claude" }),
    );
    mocks.getConsolidatedHistory.mockReturnValue([
      {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "I could not finish the audit." },
        },
      },
    ]);

    const res = await get(
      `http://localhost/api/harness/instructions?repoPath=${encodeURIComponent(root)}&includeAudit=1&auditProvider=claude`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audit.status).toBe("heuristic");
    expect(body.audit.error).toContain("Unable to locate JSON output");
    expect(mocks.killSession).toHaveBeenCalledWith("sess-audit-3");
  });

  it("joins chunked agent messages before extracting the audit JSON", async () => {
    const root = makeTempRepo();
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Guidance\n", "utf8");

    mocks.handleSessionNew.mockResolvedValue(
      jsonRpcSuccess({ sessionId: "sess-audit-4", provider: "claude" }),
    );
    const serialized = JSON.stringify(auditPayload);
    const firstHalf = serialized.slice(0, 20);
    const secondHalf = serialized.slice(20);
    mocks.getConsolidatedHistory.mockReturnValue([
      { update: { sessionUpdate: "agent_message_chunk", content: { text: firstHalf } } },
      { update: { sessionUpdate: "agent_message_chunk", content: { text: secondHalf } } },
    ]);

    const res = await get(
      `http://localhost/api/harness/instructions?repoPath=${encodeURIComponent(root)}&includeAudit=1&auditProvider=claude`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audit.status).toBe("ok");
    expect(body.audit.totalScore).toBe(14);
    expect(mocks.killSession).toHaveBeenCalledWith("sess-audit-4");
  });
});
