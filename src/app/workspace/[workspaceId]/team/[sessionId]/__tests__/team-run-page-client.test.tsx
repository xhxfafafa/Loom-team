import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AcpClientError } from "@/client/acp-client";

import { TeamRunPageClient } from "../team-run-page-client";

const {
  mockDesktopAwareFetch,
  mockSelectSession,
  mockResumeSession,
  mockConnect,
  mockPromptSession,
  mockPeekPendingPromptPayload,
  mockClearPendingPrompt,
  mockEnsurePendingPromptDeliveryId,
  mockHeaderProps,
} = vi.hoisted(() => ({
  mockDesktopAwareFetch: vi.fn(),
  mockSelectSession: vi.fn(),
  mockResumeSession: vi.fn(async (): Promise<unknown> => ({ sessionId: "session-1" })),
  mockConnect: vi.fn(async () => {}),
  mockPromptSession: vi.fn(async () => {}),
  mockPeekPendingPromptPayload: vi.fn((): unknown => null),
  mockClearPendingPrompt: vi.fn(),
  mockEnsurePendingPromptDeliveryId: vi.fn((): string | null => "test-delivery-id"),
  mockHeaderProps: [] as Array<{ teamRuns: Array<{ sessionId: string; name?: string }> }>,
}));

let mockAcpSessionId: string | null = "session-1";
/** Per-test override for the `/api/sessions/session-1` detail payload. */
let mockSessionDetail: Record<string, unknown> | null = null;
/** Mutable ACP update feed so tests can simulate further session updates. */
let mockAcpUpdates: Array<Record<string, unknown>> = [];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: {
      common: {
        back: "Back",
        refresh: "Refresh",
      },
      team: {
        openSession: "Open session details",
        active: "ACTIVE",
        waitingForDelegation: "Waiting for delegation",
        loadingTeamRun: "Loading team run",
        teamRuns: "Team Runs",
      },
      teamRuntime: {
        promptFailed: "Prompt failed",
        promptRetry: "Retry",
        promptErrorRuntimeOwned: "Another Routa instance still owns this runtime.",
        promptErrorRecoveryUnavailable: "Recovery is temporarily unavailable.",
        promptErrorSessionNotFound: "Session not found.",
        promptErrorMissingTeamMetadata: "Team metadata is missing.",
        promptErrorTeamBindingsIncomplete: "Team bindings are incomplete.",
        promptErrorImagesUnsupported: "Images are not supported here.",
      },
    },
  }),
}));

vi.mock("../use-real-team-run-params", () => ({
  useRealTeamRunParams: () => ({
    workspaceId: "default",
    sessionId: "session-1",
    isResolved: true,
  }),
}));

vi.mock("@/client/hooks/use-acp", () => ({
  useAcp: () => ({
    connected: true,
    loading: false,
    sessionId: mockAcpSessionId,
    updates: mockAcpUpdates,
    providers: [{ id: "codex", name: "Codex", description: "Codex", command: "codex-acp" }],
    selectedProvider: "codex",
    connect: mockConnect,
    prompt: vi.fn(async () => {}),
    promptSession: mockPromptSession,
    setProvider: vi.fn(),
    selectSession: mockSelectSession,
    resumeSession: mockResumeSession,
  }),
}));

vi.mock("@/client/utils/pending-prompt", () => ({
  peekPendingPromptPayload: mockPeekPendingPromptPayload,
  clearPendingPrompt: mockClearPendingPrompt,
  ensurePendingPromptDeliveryId: mockEnsurePendingPromptDeliveryId,
}));

vi.mock("@/client/acp-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/client/acp-client")>();
  return {
    ...actual,
    // Keep the retry DECISION (retryable structured failure carrying a lease
    // hint) but strip the minimum clamp and jitter so the page retry timer
    // fires fast and deterministically in tests.
    computeRecoveryRetryDelayMs: vi.fn((error: unknown): number | null => {
      const data = (error as { data?: { retryable?: unknown } } | null)?.data;
      if (!data || typeof data !== "object") return null;
      return data.retryable === true ? 25 : null;
    }),
  };
});

vi.mock("@/client/hooks/use-workspaces", () => ({
  useWorkspaces: () => ({
    workspaces: [
      {
        id: "default",
        title: "Default Workspace",
      },
    ],
    loading: false,
    createWorkspace: vi.fn(async () => null),
  }),
  useCodebases: () => ({
    codebases: [],
  }),
}));

vi.mock("@/client/hooks/use-notes", () => ({
  useNotes: () => ({
    notes: [],
  }),
}));

vi.mock("@/client/components/desktop-app-shell", () => ({
  DesktopAppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/client/components/workspace-switcher", () => ({
  WorkspaceSwitcher: () => <div data-testid="workspace-switcher" />,
}));

vi.mock("@/client/components/tiptap-input", () => ({
  TiptapInput: () => <div data-testid="tiptap-input" />,
}));

vi.mock("@/client/utils/diagnostics", () => ({
  desktopAwareFetch: mockDesktopAwareFetch,
}));

vi.mock("../team-run-page-sections", () => ({
  ObjectiveSidebarSection: () => <div data-testid="objective-sidebar" />,
  SessionTimelineSection: () => <div data-testid="session-timeline" />,
  TeamMembersSection: () => <div data-testid="team-members" />,
}));

vi.mock("../team-run-session-modal", () => ({
  TeamRunSessionModal: () => null,
}));

vi.mock("../team-run-page-header", () => ({
  TeamRunPageHeader: (props: { teamRuns: Array<{ sessionId: string; name?: string }> }) => {
    mockHeaderProps.push({ teamRuns: props.teamRuns });
    return (
      <div data-testid="team-run-header">
        {props.teamRuns.map((run) => run.name ?? run.sessionId).join(" | ")}
      </div>
    );
  },
}));

describe("TeamRunPageClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeaderProps.length = 0;
    mockAcpSessionId = "session-1";
    mockSessionDetail = null;
    mockAcpUpdates = [{ update: { sessionUpdate: "acp_status", status: "ready" } }];

    mockDesktopAwareFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/specialists") {
        return { ok: true, json: async () => ({ specialists: [] }) } as Response;
      }
      if (url === "/api/sessions/session-1") {
        return {
          ok: true,
          json: async () => ({
            session: mockSessionDetail ?? {
              sessionId: "session-1",
              name: "Team - Original run",
              workspaceId: "default",
              provider: "codex",
              role: "ROUTA",
              createdAt: "2026-04-18T00:00:00.000Z",
            },
          }),
        } as Response;
      }
      if (url === "/api/sessions?workspaceId=default") {
        return {
          ok: true,
          json: async () => ({
            sessions: [
              {
                sessionId: "session-1",
                name: "Team - Original run",
                workspaceId: "default",
                role: "ROUTA",
                createdAt: "2026-04-18T00:00:00.000Z",
              },
            ],
          }),
        } as Response;
      }
      if (url === "/api/sessions?workspaceId=default&surface=team") {
        return {
          ok: true,
          json: async () => ({
            sessions: [
              {
                sessionId: "session-1",
                name: "Team - Original run",
                workspaceId: "default",
                role: "ROUTA",
                createdAt: "2026-04-18T00:00:00.000Z",
              },
              {
                sessionId: "session-2",
                name: "Team - Follow-up",
                workspaceId: "default",
                role: "ROUTA",
                createdAt: "2026-04-17T00:00:00.000Z",
              },
            ],
          }),
        } as Response;
      }
      if (url === "/api/agents?workspaceId=default") {
        return { ok: true, json: async () => ({ agents: [] }) } as Response;
      }
      if (url === "/api/sessions/session-1/transcript") {
        return { ok: true, json: async () => ({ history: [], messages: [] }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
  });

  it("loads team run switcher options from the backend team surface", async () => {
    render(<TeamRunPageClient />);

    await waitFor(() => {
      expect(mockDesktopAwareFetch).toHaveBeenCalledWith(
        "/api/sessions?workspaceId=default&surface=team",
        expect.objectContaining({ cache: "no-store" }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("team-run-header").textContent).toContain("Team - Original run");
      expect(screen.getByTestId("team-run-header").textContent).toContain("Team - Follow-up");
    });

    expect(mockHeaderProps.at(-1)?.teamRuns.map((run) => run.sessionId)).toEqual([
      "session-1",
      "session-2",
    ]);
  });

  it("waits for the target ACP session before consuming and sending the initial prompt", async () => {
    mockAcpSessionId = null;
    mockPeekPendingPromptPayload.mockReturnValue({
      text: "Coordinate this team run",
      timestamp: Date.now(),
    });

    const { rerender } = render(<TeamRunPageClient />);

    await waitFor(() => {
      expect(mockDesktopAwareFetch).toHaveBeenCalledWith(
        "/api/sessions/session-1",
        expect.objectContaining({ cache: "no-store" }),
      );
    });
    expect(mockPeekPendingPromptPayload).not.toHaveBeenCalled();
    expect(mockPromptSession).not.toHaveBeenCalled();

    mockAcpSessionId = "session-1";
    rerender(<TeamRunPageClient />);

    await waitFor(() => {
      expect(mockPeekPendingPromptPayload).toHaveBeenCalledWith("session-1", {
        maxAgeMs: 600_000,
      });
      expect(mockPromptSession).toHaveBeenCalledWith(
        "session-1",
        "Coordinate this team run",
        undefined,
        { promptId: "test-delivery-id" },
      );
    });
    // The handoff is cleared only after the backend accepted the delivery.
    expect(mockClearPendingPrompt).toHaveBeenCalledWith("session-1");
  });

  it("delivers the pending prompt with its stored promptId and clears it only after acceptance", async () => {
    mockPeekPendingPromptPayload.mockReturnValue({
      text: "Coordinate this team run",
      timestamp: Date.now(),
      promptId: "stable-prompt-1",
    });

    render(<TeamRunPageClient />);

    await waitFor(() => {
      expect(mockPromptSession).toHaveBeenCalledWith(
        "session-1",
        "Coordinate this team run",
        undefined,
        { promptId: "stable-prompt-1" },
      );
    });
    // The stored identity is reused verbatim; no replacement id is generated.
    expect(mockEnsurePendingPromptDeliveryId).not.toHaveBeenCalled();
    expect(mockClearPendingPrompt).toHaveBeenCalledWith("session-1");
  });

  it("keeps the pending prompt when delivery is rejected and reuses one promptId on retry", async () => {
    mockPeekPendingPromptPayload.mockReturnValue({
      text: "Coordinate this team run",
      timestamp: Date.now(),
      promptId: "stable-prompt-1",
    });
    mockPromptSession
      .mockRejectedValueOnce(new Error("prompt dispatch interrupted"))
      .mockResolvedValue(undefined);

    render(<TeamRunPageClient />);

    // The first attempt rejects. Delivery retries (triggered by session state
    // settling, exactly as after a recovery retry) must reuse ONE delivery
    // identity for backend deduplication, and the handoff is cleared only
    // after the backend accepts.
    await waitFor(() => {
      expect(mockClearPendingPrompt).toHaveBeenCalledTimes(1);
      expect(mockClearPendingPrompt).toHaveBeenCalledWith("session-1");
    });
    // At least one rejected attempt plus the accepted retry.
    expect(mockPromptSession.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of mockPromptSession.mock.calls) {
      expect(call).toEqual([
        "session-1",
        "Coordinate this team run",
        undefined,
        { promptId: "stable-prompt-1" },
      ]);
    }
    // The payload was peeked once and carried in a ref across the failure:
    // a rejected delivery never drops or re-reads the pending prompt.
    expect(mockPeekPendingPromptPayload).toHaveBeenCalledTimes(1);
  });

  it("attaches an active Team Lead with selectSession without calling session/load", async () => {
    mockAcpSessionId = null;
    mockSessionDetail = {
      sessionId: "session-1",
      name: "Team - Original run",
      workspaceId: "default",
      provider: "codex",
      role: "ROUTA",
      createdAt: "2026-04-18T00:00:00.000Z",
      cwd: "/repo/team-run",
      continuityStatus: "active",
    };

    render(<TeamRunPageClient />);

    await waitFor(() => {
      expect(mockSelectSession).toHaveBeenCalledWith("session-1");
    });
    // Active local runtimes attach SSE only; recovery must not recreate the provider runtime.
    expect(mockResumeSession).not.toHaveBeenCalled();
  });

  it("recovers a restorable Team Lead through session/load without also selecting", async () => {
    mockAcpSessionId = null;
    mockSessionDetail = {
      sessionId: "session-1",
      name: "Team - Original run",
      workspaceId: "default",
      provider: "codex",
      role: "ROUTA",
      createdAt: "2026-04-18T00:00:00.000Z",
      cwd: "/repo/team-run",
      continuityStatus: "restorable",
    };

    const { rerender } = render(<TeamRunPageClient />);

    await waitFor(() => {
      expect(mockResumeSession).toHaveBeenCalledWith("session-1", "/repo/team-run", {
        throwOnError: true,
      });
    });
    // session/load attaches SSE itself; a parallel selectSession would race the recovery.
    expect(mockSelectSession).not.toHaveBeenCalled();

    rerender(<TeamRunPageClient />);
    expect(mockResumeSession).toHaveBeenCalledTimes(1);
    expect(mockSelectSession).not.toHaveBeenCalled();
  });

  it("keeps at most one recovery attempt in flight per page context", async () => {
    mockAcpSessionId = null;
    mockSessionDetail = {
      sessionId: "session-1",
      name: "Team - Original run",
      workspaceId: "default",
      provider: "codex",
      role: "ROUTA",
      createdAt: "2026-04-18T00:00:00.000Z",
      cwd: "/repo/team-run",
      continuityStatus: "restorable",
    };

    let resolveResume: (value: unknown) => void = () => {};
    mockResumeSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResume = resolve;
        }),
    );

    const { rerender } = render(<TeamRunPageClient />);

    await waitFor(() => {
      expect(mockResumeSession).toHaveBeenCalledTimes(1);
    });

    // Dependency churn while the recovery attempt is still in flight must not
    // start a second concurrent Resume call.
    mockAcpSessionId = "session-other";
    rerender(<TeamRunPageClient />);

    expect(mockResumeSession).toHaveBeenCalledTimes(1);

    resolveResume({ sessionId: "session-1" });
  });

  it("re-enters session/load after the lease-hint wait on a retryable ownership conflict", async () => {
    mockAcpSessionId = null;
    mockSessionDetail = {
      sessionId: "session-1",
      name: "Team - Original run",
      workspaceId: "default",
      provider: "codex",
      role: "ROUTA",
      createdAt: "2026-04-18T00:00:00.000Z",
      cwd: "/repo/team-run",
      continuityStatus: "restorable",
    };
    const ownershipError = new AcpClientError(
      "Session runtime is owned by another Routa instance",
      -32010,
      undefined,
      undefined,
      {
        reason: "runtime_owned",
        retryable: true,
        ownerInstanceId: "next-99999",
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        retryAfterMs: 45_000,
      },
    );
    mockResumeSession
      .mockRejectedValueOnce(ownershipError)
      .mockResolvedValue({ sessionId: "session-1" });

    render(<TeamRunPageClient />);

    await waitFor(() => {
      expect(mockResumeSession).toHaveBeenCalledTimes(1);
    });

    // The retryable conflict is not terminal: recovery re-enters session/load
    // after the lease-hint wait instead of stopping after the first failure.
    await waitFor(() => {
      expect(mockResumeSession).toHaveBeenCalledTimes(2);
    });
    expect(mockSelectSession).not.toHaveBeenCalled();
  });

  it("does not auto-retry a non-retryable recovery failure and shows the localized error", async () => {
    mockAcpSessionId = null;
    mockSessionDetail = {
      sessionId: "session-1",
      name: "Team - Original run",
      workspaceId: "default",
      provider: "codex",
      role: "ROUTA",
      createdAt: "2026-04-18T00:00:00.000Z",
      cwd: "/repo/team-run",
      continuityStatus: "restorable",
    };
    const recoveryFailedError = new AcpClientError(
      "Team metadata is missing",
      -32012,
      undefined,
      undefined,
      { reason: "recovery_failed", retryable: false, failure: "missing_team_metadata" },
    );
    mockResumeSession.mockRejectedValue(recoveryFailedError);

    render(<TeamRunPageClient />);

    await waitFor(() => {
      expect(mockResumeSession).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText("Team metadata is missing.")).toBeTruthy();
    });
    expect(mockSelectSession).not.toHaveBeenCalled();

    // No lease-hint retry timer fires for a non-retryable failure.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mockResumeSession).toHaveBeenCalledTimes(1);
  });

  it("manual Retry re-enters session/load after a recovery failure", async () => {
    mockAcpSessionId = null;
    mockSessionDetail = {
      sessionId: "session-1",
      name: "Team - Original run",
      workspaceId: "default",
      provider: "codex",
      role: "ROUTA",
      createdAt: "2026-04-18T00:00:00.000Z",
      cwd: "/repo/team-run",
      continuityStatus: "restorable",
    };
    const unavailableError = new AcpClientError(
      "Recovery is temporarily unavailable",
      -32011,
      undefined,
      undefined,
      { reason: "recovery_unavailable", retryable: false },
    );
    mockResumeSession
      .mockRejectedValueOnce(unavailableError)
      .mockResolvedValue({ sessionId: "session-1" });

    render(<TeamRunPageClient />);

    await waitFor(() => {
      expect(screen.getByText("Recovery is temporarily unavailable.")).toBeTruthy();
    });
    expect(mockResumeSession).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(mockResumeSession).toHaveBeenCalledTimes(2);
    });
    expect(mockSelectSession).not.toHaveBeenCalled();
  });
});
