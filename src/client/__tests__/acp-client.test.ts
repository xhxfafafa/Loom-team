/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpClientError, BrowserAcpClient, computeRecoveryRetryDelayMs } from "../acp-client";

class MockEventSource {
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  readonly url: string;
  readyState = 1;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }

  emitMessage(payload: unknown, lastEventId?: string) {
    this.onmessage?.({
      data: JSON.stringify(payload),
      lastEventId: lastEventId ?? "",
    } as MessageEvent<string>);
  }

  emitClosedError() {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.();
  }

  static reset() {
    MockEventSource.instances = [];
  }
}

describe("BrowserAcpClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.reset();
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reconnects with the last seen SSE event id", async () => {
    const client = new BrowserAcpClient("");
    client.attachSession("session-1");
    await vi.waitFor(() => {
      expect(MockEventSource.instances[0]).toBeDefined();
    });

    const first = MockEventSource.instances[0];
    expect(first.url).toBe(`${window.location.origin}/api/acp?sessionId=session-1`);
    expect(first.url).not.toContain("lastEventId=");

    first.emitMessage({
      method: "session/update",
      params: {
        sessionId: "session-1",
        eventId: "evt-1",
        update: { sessionUpdate: "agent_message" },
      },
    }, "evt-1");

    first.emitClosedError();
    await vi.advanceTimersByTimeAsync(2000);

    const second = MockEventSource.instances[1];
    expect(second).toBeDefined();
    expect(second.url).toContain("sessionId=session-1");
    expect(second.url).toContain("lastEventId=evt-1");
  });

  it("retries transient ownership conflicts before attaching", async () => {
    let requestCount = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      requestCount += 1;
      if (requestCount <= 2) {
        return new Response(JSON.stringify({
          error: "Session is currently owned by instance web-2 until 2099-01-01T00:00:00.000Z.",
          ownerInstanceId: "web-2",
          leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    }));

    const client = new BrowserAcpClient("");
    const issues: string[] = [];
    client.onConnectionIssue((issue) => {
      issues.push(issue.message);
    });

    client.attachSession("session-1");
    await vi.runAllTimersAsync();

    expect(MockEventSource.instances).toHaveLength(1);
    expect(requestCount).toBeGreaterThanOrEqual(3);
    expect(issues).toEqual([
      "Session is currently owned by instance web-2 until 2099-01-01T00:00:00.000Z.",
      "Session is currently owned by instance web-2 until 2099-01-01T00:00:00.000Z.",
    ]);
  });

  it("loads an existing session and attaches SSE to it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.method === "session/load") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            sessionId: "session-resume-1",
            provider: "codex",
            acpStatus: "ready",
            resumeMode: "native",
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    }));

    const client = new BrowserAcpClient("");
    const result = await client.loadSession({
      sessionId: "session-resume-1",
      cwd: "/tmp/codex",
    });

    expect(result).toMatchObject({
      sessionId: "session-resume-1",
      provider: "codex",
      resumeMode: "native",
    });
    expect(client.sessionId).toBe("session-resume-1");
    await vi.waitFor(() => {
      expect(MockEventSource.instances[0]?.url).toContain("sessionId=session-resume-1");
    });
  });

  it("preserves sessionMayContinue on RPC errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32000,
        message: "Session timed out but may continue",
        sessionMayContinue: true,
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const client = new BrowserAcpClient("");

    await expect(client.initialize()).rejects.toMatchObject({
      code: -32000,
      message: "Session timed out but may continue",
      sessionMayContinue: true,
    });
  });

  it("preserves sessionMayContinue on prompt errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32010,
        message: "Prompt timed out",
        sessionMayContinue: true,
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const client = new BrowserAcpClient("");

    await expect(client.prompt("session-1", "continue")).rejects.toMatchObject({
      code: -32010,
      message: "Prompt timed out",
      sessionMayContinue: true,
    });
  });

  it("passes taskAdaptiveHarness options through session/new", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body?.id ?? 1,
        result: {
          sessionId: "session-task-adaptive-1",
          provider: "codex",
          role: "DEVELOPER",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new BrowserAcpClient("");
    const result = await client.newSession({
      workspaceId: "default",
      provider: "codex",
      cwd: "/repo/default",
      taskAdaptiveHarness: {
        taskLabel: "Implement task-adaptive harness",
        filePaths: ["src/app/page.tsx"],
        historySessionIds: ["session-a"],
        taskType: "implementation",
      },
    });

    expect(result.sessionId).toBe("session-task-adaptive-1");
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.method).toBe("session/new");
    expect(body.params.taskAdaptiveHarness).toMatchObject({
      taskLabel: "Implement task-adaptive harness",
      filePaths: ["src/app/page.tsx"],
      historySessionIds: ["session-a"],
      taskType: "implementation",
    });
  });

  it("reuses the caller-provided promptId for every delivery attempt", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id?: number;
        params?: Record<string, unknown>;
      };
      bodies.push(body);
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body?.id ?? 1,
        result: {
          promptId: body?.params?.promptId,
          promptAccepted: true,
          duplicate: false,
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new BrowserAcpClient("");
    // Recovery retries must reuse ONE delivery identity so the backend can
    // deduplicate the dispatch.
    const first = await client.prompt("session-1", "Coordinate this team run", undefined, {
      promptId: "stable-prompt-1",
    });
    const second = await client.prompt("session-1", "Coordinate this team run", undefined, {
      promptId: "stable-prompt-1",
    });

    expect(first.promptAccepted).toBe(true);
    expect(second.promptAccepted).toBe(true);
    expect(bodies.map((body) => (body.params as Record<string, unknown>).promptId)).toEqual([
      "stable-prompt-1",
      "stable-prompt-1",
    ]);

    // Without an explicit delivery identity every attempt gets a fresh id —
    // callers that need deduplication must pass the stored promptId through.
    await client.prompt("session-1", "fresh attempt");
    const generated = (bodies[2].params as Record<string, unknown>).promptId;
    expect(generated).toEqual(expect.any(String));
    expect(generated).not.toBe("stable-prompt-1");
  });

  describe("computeRecoveryRetryDelayMs", () => {
    function ownershipError(data: Record<string, unknown>): AcpClientError {
      return new AcpClientError(
        "Session runtime is owned by another Routa instance",
        -32010,
        undefined,
        undefined,
        data,
      );
    }

    it("returns null for errors without structured recovery data", () => {
      expect(computeRecoveryRetryDelayMs(new Error("boom"))).toBeNull();
      expect(computeRecoveryRetryDelayMs("boom")).toBeNull();
      expect(computeRecoveryRetryDelayMs(new AcpClientError("plain", -32000))).toBeNull();
      expect(computeRecoveryRetryDelayMs(ownershipError({ reason: "runtime_owned" }))).toBeNull();
    });

    it("returns null when the structured failure is not retryable", () => {
      expect(
        computeRecoveryRetryDelayMs(
          ownershipError({ reason: "recovery_failed", retryable: false, retryAfterMs: 45000 }),
        ),
      ).toBeNull();
    });

    it("returns null when retryable but no lease hint is present", () => {
      expect(
        computeRecoveryRetryDelayMs(ownershipError({ reason: "runtime_owned", retryable: true })),
      ).toBeNull();
    });

    it("derives the delay from retryAfterMs with bounded jitter", () => {
      const random = vi.spyOn(Math, "random");
      try {
        random.mockReturnValue(0);
        expect(
          computeRecoveryRetryDelayMs(
            ownershipError({ reason: "runtime_owned", retryable: true, retryAfterMs: 45000 }),
          ),
        ).toBe(45000);
        random.mockReturnValue(0.9999);
        expect(
          computeRecoveryRetryDelayMs(
            ownershipError({ reason: "runtime_owned", retryable: true, retryAfterMs: 45000 }),
          ),
        ).toBe(46999);
      } finally {
        random.mockRestore();
      }
    });

    it("prefers retryAfterMs over leaseExpiresAt", () => {
      const random = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        expect(
          computeRecoveryRetryDelayMs(
            ownershipError({
              reason: "runtime_owned",
              retryable: true,
              retryAfterMs: 45000,
              leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          ),
        ).toBe(45000);
      } finally {
        random.mockRestore();
      }
    });

    it("falls back to leaseExpiresAt when retryAfterMs is absent", () => {
      const random = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        expect(
          computeRecoveryRetryDelayMs(
            ownershipError({
              reason: "runtime_owned",
              retryable: true,
              leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          ),
        ).toBe(60_000);
      } finally {
        random.mockRestore();
      }
    });

    it("clamps a tiny lease hint to a small positive minimum", () => {
      const random = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        expect(
          computeRecoveryRetryDelayMs(
            ownershipError({ reason: "runtime_owned", retryable: true, retryAfterMs: 0 }),
          ),
        ).toBe(1000);
      } finally {
        random.mockRestore();
      }
    });

    it("caps the delay at the default lease duration", () => {
      const random = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        expect(
          computeRecoveryRetryDelayMs(
            ownershipError({ reason: "runtime_owned", retryable: true, retryAfterMs: 900_000 }),
          ),
        ).toBe(300_000);
      } finally {
        random.mockRestore();
      }
    });
  });
});
