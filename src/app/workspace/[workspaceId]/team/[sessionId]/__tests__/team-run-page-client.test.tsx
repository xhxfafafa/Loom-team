import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AcpClientError } from "@/client/acp-client";
import { encodeBytesToBase64 } from "@/core/kanban/task-attachments";

import { TeamRunPageClient } from "../team-run-page-client";

interface MockRepoSelection {
  path: string;
  branch: string;
  name: string;
}

interface MockTiptapInputProps {
  onSend: (text: string, context: { files?: Array<{ path: string; label: string }> }) => void;
  onTextChange?: (text: string) => void;
  prefillText?: string | null;
  onPrefillConsumed?: () => void;
  disabled?: boolean;
  attachmentsEnabled?: boolean;
  attachmentDrafts?: Array<{ id: string; file: File }>;
  attachmentErrors?: string[];
  attachmentsDisabled?: boolean;
  onAddAttachmentFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  repoSelection?: MockRepoSelection | null;
}

interface MockTimelineSectionProps {
  leadMessages?: Array<{ id: string; role: string; content: string }>;
  sessionLanes?: unknown[];
}

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
  mockTiptapProps,
  mockTimelineSectionProps,
  mockTeamRunParams,
  mockTimelineControls,
  mockPrefillHistory,
  mockReadTeamAttachmentTransfer,
  mockDeleteTeamAttachmentTransfer,
} = vi.hoisted(() => ({
  mockDesktopAwareFetch: vi.fn(),
  mockSelectSession: vi.fn(),
  mockResumeSession: vi.fn(async (): Promise<unknown> => ({ sessionId: "session-1" })),
  mockConnect: vi.fn(async () => {}),
  mockPromptSession: vi.fn(
    async (
      _sessionId: string,
      _content?: unknown,
      _skillContext?: unknown,
      _options?: Record<string, unknown>,
    ): Promise<void> => {},
  ),
  mockPeekPendingPromptPayload: vi.fn((): unknown => null),
  mockClearPendingPrompt: vi.fn(),
  mockEnsurePendingPromptDeliveryId: vi.fn((): string | null => "test-delivery-id"),
  mockHeaderProps: [] as Array<{ teamRuns: Array<{ sessionId: string; name?: string }> }>,
  mockTiptapProps: { current: null as MockTiptapInputProps | null },
  /** Latest props received by the mocked SessionTimelineSection. */
  mockTimelineSectionProps: { current: null as MockTimelineSectionProps | null },
  /** Mutable route params so tests can switch between Team Runs. */
  mockTeamRunParams: { workspaceId: "default", sessionId: "session-1" },
  mockTimelineControls: {
    sendText: "",
    sendContext: {} as { files?: Array<{ path: string; label: string }> },
    filesToAdd: [] as File[],
  },
  /** Every non-null prefillText the composer mock received, in order. */
  mockPrefillHistory: [] as string[],
  mockReadTeamAttachmentTransfer: vi.fn(async (_transferId?: string): Promise<unknown> => null),
  mockDeleteTeamAttachmentTransfer: vi.fn(async (_transferId?: string): Promise<void> => {}),
}));

let mockAcpSessionId: string | null = "session-1";
/** Per-test override for the `/api/sessions/session-1` detail payload. */
let mockSessionDetail: Record<string, unknown> | null = null;
/** Mutable ACP update feed so tests can simulate further session updates. */
let mockAcpUpdates: Array<Record<string, unknown>> = [];
/** Workspace session list backing descendant-session discovery. */
let mockWorkspaceSessions: Array<Record<string, unknown>> = [];
/** Per-session transcript responders so tests can defer or fail a response. */
let transcriptResponders = new Map<string, () => Promise<Response>>();
/** Mutable document visibility backing the polling visibility gate. */
let documentVisibilityState: "visible" | "hidden" = "visible";

const okJsonResponse = (data: unknown): Response =>
  ({ ok: true, json: async () => data }) as Response;

function createDeferred<T>() {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

const transcriptUrl = (targetSessionId: string) =>
  `/api/sessions/${targetSessionId}/transcript`;

const transcriptCallCount = (targetSessionId: string) =>
  mockDesktopAwareFetch.mock.calls.filter(
    ([url]) => String(url) === transcriptUrl(targetSessionId),
  ).length;

const currentLeadMessageTexts = (): string[] =>
  (mockTimelineSectionProps.current?.leadMessages ?? []).map((message) => message.content);

const setDocumentVisibility = (nextState: "visible" | "hidden") => {
  documentVisibilityState = nextState;
  document.dispatchEvent(new Event("visibilitychange"));
};

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
      teamAttachments: {
        addFiles: "Attach text or image files",
        removeFile: "Remove attachment",
        prepareFailed: "Attachment preparation failed. Your files are kept — please try again.",
        handoffFailed: "The Team session was created, but the launch handoff could not be stored.",
        firstPromptFailed: "The first Team prompt was not sent. Attachments are kept for retry.",
      },
      taskAttachments: {
        validation: {
          tooManyAttachments: "Too many attachments: a task accepts at most 5 files.",
          tooManyImages: "Too many images: a task accepts at most 3 images.",
          invalidFilename: "Invalid file name.",
          filenameTooLong: "File name is too long (max 255 characters).",
          unsupportedExtension: "Unsupported file format. Use text files or PNG/JPEG/WebP images.",
          invalidFile: "Invalid file content.",
          textTooLarge: "Text file is too large (max 256 KB).",
          imageTooLarge: "Image is too large (max 2 MB).",
          totalTooLarge: "Attachments exceed the 6 MB total limit.",
        },
      },
    },
  }),
}));

vi.mock("../use-real-team-run-params", () => ({
  useRealTeamRunParams: () => ({
    workspaceId: mockTeamRunParams.workspaceId,
    sessionId: mockTeamRunParams.sessionId,
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
  // Prop-capturing mock: renders test controls for Send, add/remove files,
  // attachment state inspection, and mirrors the real prefill -> onTextChange
  // sync so retry-availability logic behaves like the real composer.
  TiptapInput: (props: Record<string, unknown>) => {
    const typed = props as unknown as MockTiptapInputProps;
    mockTiptapProps.current = typed;
    const { prefillText, onTextChange, onPrefillConsumed } = typed;
    React.useEffect(() => {
      if (prefillText) {
        mockPrefillHistory.push(prefillText);
        onTextChange?.(prefillText);
        onPrefillConsumed?.();
      }
    }, [prefillText, onTextChange, onPrefillConsumed]);
    return (
      <div data-testid="tiptap-input">
        <button
          type="button"
          data-testid="tiptap-send"
          onClick={() => typed.onSend(mockTimelineControls.sendText, mockTimelineControls.sendContext)}
        >
          send prompt
        </button>
        <button
          type="button"
          data-testid="tiptap-add-files"
          onClick={() => typed.onAddAttachmentFiles?.(mockTimelineControls.filesToAdd)}
        >
          add files
        </button>
        {(typed.attachmentDrafts ?? []).map((draft) => (
          <span key={draft.id} data-testid={`tiptap-draft-${draft.file.name}`}>
            {draft.file.name}
            <button
              type="button"
              data-testid={`tiptap-remove-${draft.file.name}`}
              onClick={() => typed.onRemoveAttachment?.(draft.id)}
            >
              remove {draft.file.name}
            </button>
          </span>
        ))}
        {(typed.attachmentErrors ?? []).map((message, index) => (
          <span key={`${index}-${message}`} data-testid="tiptap-attachment-error">
            {message}
          </span>
        ))}
      </div>
    );
  },
}));

vi.mock("@/client/utils/team-attachment-transfer", () => ({
  readTeamAttachmentTransfer: mockReadTeamAttachmentTransfer,
  deleteTeamAttachmentTransfer: mockDeleteTeamAttachmentTransfer,
  saveTeamAttachmentTransfer: vi.fn(async () => "transfer-mock"),
}));

vi.mock("@/client/utils/diagnostics", () => ({
  desktopAwareFetch: mockDesktopAwareFetch,
}));

vi.mock("../team-run-page-sections", () => ({
  ObjectiveSidebarSection: () => <div data-testid="objective-sidebar" />,
  SessionTimelineSection: (props: Record<string, unknown>) => {
    mockTimelineSectionProps.current = props as unknown as MockTimelineSectionProps;
    return <div data-testid="session-timeline" />;
  },
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
    // clearAllMocks keeps implementations set by earlier tests; restore the
    // defaults this suite relies on so state never leaks across tests.
    mockPeekPendingPromptPayload.mockReturnValue(null);
    mockPromptSession.mockReset();
    mockPromptSession.mockResolvedValue(undefined);
    mockReadTeamAttachmentTransfer.mockReset();
    mockReadTeamAttachmentTransfer.mockResolvedValue(null);
    mockDeleteTeamAttachmentTransfer.mockReset();
    mockDeleteTeamAttachmentTransfer.mockResolvedValue(undefined);
    mockHeaderProps.length = 0;
    mockTiptapProps.current = null;
    mockTimelineSectionProps.current = null;
    mockTeamRunParams.workspaceId = "default";
    mockTeamRunParams.sessionId = "session-1";
    mockTimelineControls.sendText = "";
    mockTimelineControls.sendContext = {};
    mockTimelineControls.filesToAdd = [];
    mockPrefillHistory.length = 0;
    mockAcpSessionId = "session-1";
    mockSessionDetail = null;
    mockAcpUpdates = [{ update: { sessionUpdate: "acp_status", status: "ready" } }];
    mockWorkspaceSessions = [
      {
        sessionId: "session-1",
        name: "Team - Original run",
        workspaceId: "default",
        role: "ROUTA",
        createdAt: "2026-04-18T00:00:00.000Z",
      },
    ];
    transcriptResponders = new Map();
    documentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => documentVisibilityState,
    });

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
      if (url === "/api/sessions/session-2") {
        return {
          ok: true,
          json: async () => ({
            session: {
              sessionId: "session-2",
              name: "Team - Follow-up",
              workspaceId: "default",
              provider: "codex",
              role: "ROUTA",
              createdAt: "2026-04-17T00:00:00.000Z",
            },
          }),
        } as Response;
      }
      if (url === "/api/sessions?workspaceId=default") {
        return {
          ok: true,
          json: async () => ({
            sessions: mockWorkspaceSessions,
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
      const transcriptMatch = url.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
      if (transcriptMatch) {
        const targetSessionId = decodeURIComponent(transcriptMatch[1]);
        const responder = transcriptResponders.get(targetSessionId);
        if (responder) {
          return responder();
        }
        return okJsonResponse({ history: [], messages: [] });
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

  describe("follow-up timeline attachments", () => {
    // Minimal valid PNG signature so the strict attachment normalizer
    // accepts the image draft built from browser File objects.
    const PNG_BYTES = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);

    const makeTextFile = (name = "notes.txt", content = "hello attachment") =>
      new File([content], name, { type: "text/plain" });
    const makePngFile = (name = "screenshot.png") =>
      new File([PNG_BYTES], name, { type: "image/png" });

    const sendFromComposer = () => fireEvent.click(screen.getByTestId("tiptap-send"));
    const addFilesFromComposer = (files: File[]) => {
      mockTimelineControls.filesToAdd = files;
      fireEvent.click(screen.getByTestId("tiptap-add-files"));
    };

    it("exposes attachment controls in the existing Team Run composer", async () => {
      render(<TeamRunPageClient />);

      await waitFor(() => {
        expect(mockTiptapProps.current).not.toBeNull();
      });
      // The follow-up composer opts into the same TiptapInput attachment UI.
      expect(mockTiptapProps.current?.attachmentsEnabled).toBe(true);
      expect(mockTiptapProps.current?.onAddAttachmentFiles).toBeTruthy();
      expect(mockTiptapProps.current?.onRemoveAttachment).toBeTruthy();

      addFilesFromComposer([makeTextFile()]);
      expect(screen.getByTestId("tiptap-draft-notes.txt")).toBeTruthy();

      fireEvent.click(screen.getByTestId("tiptap-remove-notes.txt"));
      expect(screen.queryByTestId("tiptap-draft-notes.txt")).toBeNull();
    });

    it("sends valid text plus an image attachment as ACP content blocks", async () => {
      render(<TeamRunPageClient />);
      await waitFor(() => {
        expect(mockTiptapProps.current).not.toBeNull();
      });

      addFilesFromComposer([makePngFile()]);
      expect(screen.getByTestId("tiptap-draft-screenshot.png")).toBeTruthy();

      mockTimelineControls.sendText = "Review this screenshot";
      sendFromComposer();

      await waitFor(() => {
        expect(mockPromptSession).toHaveBeenCalledTimes(1);
      });
      const call = mockPromptSession.mock.calls[0];
      expect(call[0]).toBe("session-1");
      // Order: user text first, then image blocks. Attachment bytes live only
      // in the image block — never copied into the visible text block.
      expect(call[1]).toEqual([
        { type: "text", text: "Review this screenshot" },
        { type: "image", data: encodeBytesToBase64(PNG_BYTES), mimeType: "image/png" },
      ]);
      expect(call[2]).toBeUndefined();
      expect(call[3]).toEqual({ throwOnError: true, promptId: expect.any(String) });

      // Accepted: the complete draft is cleared.
      await waitFor(() => {
        expect(screen.queryByTestId("tiptap-draft-screenshot.png")).toBeNull();
      });
    });

    it("converts @ repository file references into safe repository-relative sections", async () => {
      mockSessionDetail = {
        sessionId: "session-1",
        name: "Team - Original run",
        workspaceId: "default",
        provider: "codex",
        role: "ROUTA",
        createdAt: "2026-04-18T00:00:00.000Z",
        cwd: "/repo/team-run",
      };

      render(<TeamRunPageClient />);
      // repoSelection is derived from the session cwd; @ references resolve
      // against it.
      await waitFor(() => {
        expect(mockTiptapProps.current?.repoSelection?.path).toBe("/repo/team-run");
      });

      mockTimelineControls.sendText = "Check these files";
      mockTimelineControls.sendContext = {
        files: [
          { path: "/repo/team-run/src/foo.ts", label: "foo.ts" },
          // Outside the selected repository: rejected, never embedded.
          { path: "/elsewhere/outside.ts", label: "outside.ts" },
        ],
      };
      sendFromComposer();

      await waitFor(() => {
        expect(mockPromptSession).toHaveBeenCalledTimes(1);
      });
      const call = mockPromptSession.mock.calls[0];
      expect(call[1]).toEqual([
        { type: "text", text: "Check these files" },
        { type: "text", text: "Repository files:\n- src/foo.ts" },
      ]);
    });

    it("clears the full draft only after the prompt was accepted", async () => {
      let acceptPrompt: () => void = () => {};
      mockPromptSession.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            acceptPrompt = resolve;
          }),
      );

      render(<TeamRunPageClient />);
      await waitFor(() => {
        expect(mockTiptapProps.current).not.toBeNull();
      });

      addFilesFromComposer([makeTextFile(), makePngFile()]);
      mockTimelineControls.sendText = "Ship the follow-up";
      sendFromComposer();

      // While the delivery is in flight the draft stays intact and the
      // composer is locked.
      expect(screen.getByTestId("tiptap-draft-notes.txt")).toBeTruthy();
      expect(screen.getByTestId("tiptap-draft-screenshot.png")).toBeTruthy();
      expect(mockTiptapProps.current?.attachmentsDisabled).toBe(true);

      await waitFor(() => {
        expect(mockPromptSession).toHaveBeenCalledTimes(1);
      });
      expect(screen.getByTestId("tiptap-draft-notes.txt")).toBeTruthy();

      await act(async () => {
        acceptPrompt();
      });

      // Backend accepted: the complete draft (text + every attachment) clears.
      await waitFor(() => {
        expect(screen.queryByTestId("tiptap-draft-notes.txt")).toBeNull();
        expect(screen.queryByTestId("tiptap-draft-screenshot.png")).toBeNull();
      });
      expect(screen.queryByTestId("tiptap-attachment-error")).toBeNull();
    });

    it("keeps the draft and skips the ACP call when strict validation fails", async () => {
      render(<TeamRunPageClient />);
      await waitFor(() => {
        expect(mockTiptapProps.current).not.toBeNull();
      });

      // Preflight accepts the .png extension; the strict normalizer rejects
      // the content because the image signature does not match.
      addFilesFromComposer([new File(["this is not an image"], "fake.png", { type: "image/png" })]);
      mockTimelineControls.sendText = "Send with a broken image";
      sendFromComposer();

      await waitFor(() => {
        expect(screen.getByTestId("tiptap-attachment-error")).toBeTruthy();
      });
      expect(screen.getByTestId("tiptap-attachment-error").textContent).toBe("Invalid file content.");
      // No partial prompt was sent.
      expect(mockPromptSession).not.toHaveBeenCalled();
      // The complete draft is preserved for correction.
      expect(screen.getByTestId("tiptap-draft-fake.png")).toBeTruthy();
      // The composer text cleared by the send action is prefilled back.
      await waitFor(() => {
        expect(mockPrefillHistory).toContain("Send with a broken image");
      });
    });

    it("keeps text and draft when attachment serialization fails", async () => {
      render(<TeamRunPageClient />);
      await waitFor(() => {
        expect(mockTiptapProps.current).not.toBeNull();
      });

      // A draft whose bytes cannot be read fails at serialization time,
      // before any ACP call is attempted.
      const broken = new File(["unreadable"], "broken.txt", { type: "text/plain" });
      broken.arrayBuffer = async () => {
        throw new Error("read failed");
      };
      addFilesFromComposer([broken]);
      mockTimelineControls.sendText = "Send with unreadable file";
      sendFromComposer();

      await waitFor(() => {
        expect(screen.getByTestId("tiptap-attachment-error")).toBeTruthy();
      });
      expect(screen.getByTestId("tiptap-attachment-error").textContent).toBe(
        "Attachment preparation failed. Your files are kept — please try again.",
      );
      expect(mockPromptSession).not.toHaveBeenCalled();
      expect(screen.getByTestId("tiptap-draft-broken.txt")).toBeTruthy();
      await waitFor(() => {
        expect(mockPrefillHistory).toContain("Send with unreadable file");
      });
    });

    it("keeps text and attachments when the ACP delivery fails", async () => {
      mockPromptSession.mockRejectedValueOnce(new Error("delivery interrupted"));

      render(<TeamRunPageClient />);
      await waitFor(() => {
        expect(mockTiptapProps.current).not.toBeNull();
      });

      addFilesFromComposer([makePngFile()]);
      mockTimelineControls.sendText = "Follow up please";
      sendFromComposer();

      await waitFor(() => {
        expect(screen.getByText(/delivery interrupted/)).toBeTruthy();
      });
      // Attachments survive the failure; the failed text is prefilled back
      // into the composer (proven below by the retry snapshot staying valid,
      // which requires the visible text to match the failed submission).
      expect(screen.getByTestId("tiptap-draft-screenshot.png")).toBeTruthy();
      // The unchanged draft keeps the retry snapshot valid.
      const retryButton = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
      await waitFor(() => {
        expect(retryButton.disabled).toBe(false);
      });
    });

    it("retries a failed delivery with the same promptId and identical content", async () => {
      mockPromptSession.mockRejectedValueOnce(new Error("delivery interrupted"));

      render(<TeamRunPageClient />);
      await waitFor(() => {
        expect(mockTiptapProps.current).not.toBeNull();
      });

      addFilesFromComposer([makeTextFile(), makePngFile()]);
      mockTimelineControls.sendText = "Retry me";
      sendFromComposer();

      await waitFor(() => {
        expect(screen.getByText(/delivery interrupted/)).toBeTruthy();
      });
      await waitFor(() => {
        expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false);
      });

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() => {
        expect(mockPromptSession).toHaveBeenCalledTimes(2);
      });
      // SAME promptId and byte-identical content blocks: an already-accepted
      // delivery can never be duplicated as a second provider turn.
      expect(mockPromptSession.mock.calls[1]).toEqual(mockPromptSession.mock.calls[0]);

      await waitFor(() => {
        expect(screen.queryByTestId("tiptap-draft-notes.txt")).toBeNull();
        expect(screen.queryByTestId("tiptap-draft-screenshot.png")).toBeNull();
      });
    });

    it("uses a new promptId after the failed draft was edited", async () => {
      mockPromptSession.mockRejectedValueOnce(new Error("delivery interrupted"));

      render(<TeamRunPageClient />);
      await waitFor(() => {
        expect(mockTiptapProps.current).not.toBeNull();
      });

      addFilesFromComposer([makePngFile()]);
      mockTimelineControls.sendText = "Original text";
      sendFromComposer();

      await waitFor(() => {
        expect(screen.getByText(/delivery interrupted/)).toBeTruthy();
      });
      const failedPromptId = mockPromptSession.mock.calls[0][3]!.promptId as string;
      expect(failedPromptId).toBeTruthy();

      // The prefill restores the failed text first...
      await waitFor(() => {
        expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false);
      });
      // ...then the user edits the draft: the old retry snapshot is invalidated.
      act(() => {
        mockTiptapProps.current?.onTextChange?.("Edited text");
      });
      await waitFor(() => {
        expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
      });

      mockTimelineControls.sendText = "Edited text";
      sendFromComposer();

      await waitFor(() => {
        expect(mockPromptSession).toHaveBeenCalledTimes(2);
      });
      const retryCall = mockPromptSession.mock.calls[1]!;
      // The edited submission is a NEW delivery with a NEW promptId.
      expect(retryCall[3]!.promptId).not.toBe(failedPromptId);
      const blocks = retryCall[1] as Array<Record<string, unknown>>;
      expect(blocks[0]).toEqual({ type: "text", text: "Edited text" });
    });

    it("rejects the whole prompt when the provider cannot receive images", async () => {
      const imagesUnsupportedError = new AcpClientError(
        "Provider cannot receive images",
        -32000,
        undefined,
        undefined,
        { reason: "prompt_images_unsupported" },
      );
      mockPromptSession.mockRejectedValueOnce(imagesUnsupportedError);

      render(<TeamRunPageClient />);
      await waitFor(() => {
        expect(mockTiptapProps.current).not.toBeNull();
      });

      addFilesFromComposer([makePngFile()]);
      mockTimelineControls.sendText = "Prompt with an image";
      sendFromComposer();

      await waitFor(() => {
        expect(screen.getByText(/Images are not supported here\./)).toBeTruthy();
      });
      // Exactly one attempt carrying the FULL prompt (image included): no
      // silent text-only fallback and no dropped image.
      expect(mockPromptSession).toHaveBeenCalledTimes(1);
      const payload = mockPromptSession.mock.calls[0][1] as Array<Record<string, unknown>>;
      expect(payload.some((block) => block.type === "image")).toBe(true);
      // The complete draft is preserved so the user can switch provider/retry.
      expect(screen.getByTestId("tiptap-draft-screenshot.png")).toBeTruthy();
    });

    it("keeps the initial launch IndexedDB attachment handoff and retry intact", async () => {
      mockPeekPendingPromptPayload.mockReturnValue({
        text: "Launch the team",
        timestamp: Date.now(),
        promptId: "launch-prompt-1",
        attachmentTransferId: "transfer-1",
      });
      mockReadTeamAttachmentTransfer.mockResolvedValue({
        attachments: [makeTextFile("launch-notes.txt", "launch notes")],
        createdAt: new Date().toISOString(),
      });
      mockPromptSession.mockRejectedValue(new Error("handoff rejected"));

      render(<TeamRunPageClient />);

      const expectedBlocks = [
        { type: "text", text: "Launch the team" },
        {
          type: "resource",
          resource: {
            type: "resource",
            uri: "routa-team-input://transfer-1/0",
            mimeType: "text/plain",
            text: "launch notes",
          },
        },
      ];

      // Every rejected attempt rebuilds the FULL blocks from the IndexedDB
      // transfer (no partial text-only fallback) and reuses the launch
      // promptId; the transfer record stays alive for the next attempt.
      await waitFor(() => {
        expect(mockPromptSession.mock.calls.length).toBeGreaterThanOrEqual(1);
        for (const call of mockPromptSession.mock.calls) {
          expect(call[0]).toBe("session-1");
          expect(call[1]).toEqual(expectedBlocks);
          expect(call[3]).toEqual({ throwOnError: true, promptId: "launch-prompt-1" });
        }
      });

      await waitFor(() => {
        expect(screen.getByText(/Attachments are kept for retry\./)).toBeTruthy();
      });
      // Nothing is dropped before acceptance.
      expect(mockDeleteTeamAttachmentTransfer).not.toHaveBeenCalled();
      expect(mockClearPendingPrompt).not.toHaveBeenCalled();

      // Manual Retry re-enters the same consumption path; this time accepted.
      // (Grab the button while the failure banner is guaranteed visible.)
      const retryButton = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
      mockPromptSession.mockResolvedValue(undefined);
      fireEvent.click(retryButton);

      // Only AFTER acceptance are the transfer record and handoff dropped.
      await waitFor(() => {
        expect(mockDeleteTeamAttachmentTransfer).toHaveBeenCalledWith("transfer-1");
        expect(mockClearPendingPrompt).toHaveBeenCalledWith("session-1");
      });
      const acceptedCall = mockPromptSession.mock.calls.at(-1)!;
      expect(acceptedCall[1]).toEqual(expectedBlocks);
      expect(acceptedCall[3]).toEqual({ throwOnError: true, promptId: "launch-prompt-1" });
      // Every attempt rebuilt its blocks from the transfer record.
      expect(mockReadTeamAttachmentTransfer.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const call of mockReadTeamAttachmentTransfer.mock.calls) {
        expect(call[0]).toBe("transfer-1");
      }
      // The payload was peeked once and carried across every attempt.
      expect(mockPeekPendingPromptPayload).toHaveBeenCalledTimes(1);
    });

    it("keeps attachments when recovery ownership fails mid-delivery", async () => {
      const ownershipError = new AcpClientError(
        "Session runtime is owned by another Routa instance",
        -32010,
        undefined,
        undefined,
        { reason: "runtime_owned", retryable: true },
      );
      mockPromptSession.mockRejectedValueOnce(ownershipError);

      render(<TeamRunPageClient />);
      await waitFor(() => {
        expect(mockTiptapProps.current).not.toBeNull();
      });

      addFilesFromComposer([makePngFile()]);
      mockTimelineControls.sendText = "Prompt during ownership conflict";
      sendFromComposer();

      await waitFor(() => {
        expect(screen.getByText(/Another Routa instance still owns this runtime\./)).toBeTruthy();
      });
      // The complete submission (text + attachments) survives the structured
      // recovery failure and stays retryable.
      expect(screen.getByTestId("tiptap-draft-screenshot.png")).toBeTruthy();
      await waitFor(() => {
        expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false);
      });
    });

    it("sends text-only follow-ups as plain strings without regressions", async () => {
      render(<TeamRunPageClient />);
      await waitFor(() => {
        expect(mockTiptapProps.current).not.toBeNull();
      });

      mockTimelineControls.sendText = "Just a follow-up";
      sendFromComposer();

      await waitFor(() => {
        expect(mockPromptSession).toHaveBeenCalledTimes(1);
      });
      const call = mockPromptSession.mock.calls[0];
      // No attachments and no @ references: keep the legacy string payload.
      expect(call[1]).toBe("Just a follow-up");
      expect(call[3]).toEqual({ throwOnError: true, promptId: expect.any(String) });
      expect(screen.queryByTestId("tiptap-attachment-error")).toBeNull();
    });

    it("drops run A's drafts and retry state when switching to run B", async () => {
      mockPromptSession.mockRejectedValueOnce(new Error("delivery interrupted"));
      const { rerender } = render(<TeamRunPageClient />);
      await waitFor(() => {
        expect(mockTiptapProps.current).not.toBeNull();
      });

      // Run A: an attachment plus a failed delivery produce visible retry state.
      addFilesFromComposer([makeTextFile(), makePngFile()]);
      mockTimelineControls.sendText = "Run A follow-up";
      sendFromComposer();

      await waitFor(() => {
        expect(screen.getByText(/delivery interrupted/)).toBeTruthy();
      });
      expect(screen.getByTestId("tiptap-draft-notes.txt")).toBeTruthy();
      expect(screen.getByTestId("tiptap-draft-screenshot.png")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

      // Switch to run B: run A's composer draft must not follow.
      mockTeamRunParams.sessionId = "session-2";
      rerender(<TeamRunPageClient />);

      await waitFor(() => {
        expect(screen.queryByTestId("tiptap-draft-notes.txt")).toBeNull();
        expect(screen.queryByTestId("tiptap-draft-screenshot.png")).toBeNull();
      });
      expect(screen.queryByText(/delivery interrupted/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("does not clear run B's input when run A's send settles after the switch", async () => {
      let acceptPrompt: () => void = () => {};
      mockPromptSession.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            acceptPrompt = resolve;
          }),
      );

      const { rerender } = render(<TeamRunPageClient />);
      await waitFor(() => {
        expect(mockTiptapProps.current).not.toBeNull();
      });

      // Run A starts an attachment delivery that stays in flight.
      addFilesFromComposer([makeTextFile()]);
      mockTimelineControls.sendText = "Run A follow-up";
      sendFromComposer();
      await waitFor(() => {
        expect(mockPromptSession).toHaveBeenCalledTimes(1);
      });
      expect(mockPromptSession.mock.calls[0]?.[0]).toBe("session-1");

      // Switch to run B while run A's delivery is still in flight; run B's
      // composer text arrives before run A settles.
      mockTeamRunParams.sessionId = "session-2";
      rerender(<TeamRunPageClient />);
      await waitFor(() => {
        expect(screen.queryByTestId("tiptap-draft-notes.txt")).toBeNull();
      });
      act(() => {
        mockTiptapProps.current?.onTextChange?.("Run B follow-up");
      });

      // Run A's delivery settles only now: it belongs to run A's context and
      // must not clear or overwrite run B's composer state.
      await act(async () => {
        acceptPrompt();
      });
      expect(screen.queryByText(/delivery interrupted/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(mockTiptapProps.current?.prefillText ?? null).toBeNull();

      // Run B collects its own attachment after the stale delivery settled.
      addFilesFromComposer([makePngFile()]);
      expect(screen.getByTestId("tiptap-draft-screenshot.png")).toBeTruthy();

      // Run B's next send is a fresh submission targeting run B; failing it
      // keeps the draft, and the retry snapshot stays valid only if run B's
      // text survived run A's stale completion untouched.
      mockPromptSession.mockRejectedValueOnce(new Error("Run B interrupted"));
      mockTimelineControls.sendText = "Run B follow-up";
      sendFromComposer();

      await waitFor(() => {
        expect(mockPromptSession).toHaveBeenCalledTimes(2);
      });
      const runBCall = mockPromptSession.mock.calls[1];
      expect(runBCall?.[0]).toBe("session-2");
      expect(runBCall?.[1]).toEqual([
        { type: "text", text: "Run B follow-up" },
        { type: "image", data: encodeBytesToBase64(PNG_BYTES), mimeType: "image/png" },
      ]);
      expect(runBCall?.[3]?.promptId).not.toBe(mockPromptSession.mock.calls[0]?.[3]?.promptId);

      await waitFor(() => {
        expect(screen.getByText(/Run B interrupted/)).toBeTruthy();
      });
      expect(screen.getByTestId("tiptap-draft-screenshot.png")).toBeTruthy();
      await waitFor(() => {
        expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false);
      });
    });
  });

  describe("team timeline transcript refresh", () => {
    const CHILD_SESSION_ID = "child-session-1";

    const childWorkspaceSession = {
      sessionId: CHILD_SESSION_ID,
      name: "Child crafter session",
      workspaceId: "default",
      parentSessionId: "session-1",
      role: "CRAFTER",
      createdAt: "2026-04-18T00:05:00.000Z",
    };

    /**
     * Advance fake time in small steps until the condition holds. Keeps every
     * timer-driven state update wrapped in act().
     */
    const waitUntil = async (condition: () => boolean, timeoutMs = 4000) => {
      let elapsed = 0;
      while (!condition()) {
        if (elapsed > timeoutMs) {
          throw new Error("waitUntil timed out while advancing fake timers");
        }
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
        elapsed += 50;
      }
    };

    const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    const withChildSession = () => {
      mockWorkspaceSessions = [mockWorkspaceSessions[0]!, childWorkspaceSession];
    };
    const persistedSnapshotMessages = () => [{
      id: "root-persisted-1",
      role: "assistant",
      content: "persisted snapshot",
      timestamp: "2026-08-18T00:00:00.000Z",
    }];

    /** Hold the next root transcript request in flight and return its deferred response. */
    const holdNextRootTranscript = async (expectedCallCount: number) => {
      const deferred = createDeferred<Response>();
      transcriptResponders.set("session-1", () => deferred.promise);
      window.dispatchEvent(new Event("focus"));
      await waitUntil(() => transcriptCallCount("session-1") === expectedCallCount);
      return deferred;
    };

    /** Push a fresh root SSE chunk through a rerender and wait for it to render. */
    const pushLiveRootSseChunk = async (rerender: (ui: React.ReactElement) => void) => {
      mockAcpUpdates = [
        ...mockAcpUpdates,
        { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "live sse chunk" } } },
      ];
      rerender(<TeamRunPageClient />);
      await waitUntil(() => currentLeadMessageTexts().includes("live sse chunk"));
    };

    const waitForBootstrapTranscripts = async () => {
      await waitUntil(() => transcriptCallCount("session-1") >= 1);
      if (mockWorkspaceSessions.some((entry) => entry.parentSessionId)) {
        await waitUntil(() => transcriptCallCount(CHILD_SESSION_ID) >= 1);
      }
      await settle();
    };

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("refreshes the root and descendant transcripts periodically while the page is visible", async () => {
      withChildSession();
      render(<TeamRunPageClient />);
      await waitForBootstrapTranscripts();

      const rootCallsAtBootstrap = transcriptCallCount("session-1");
      const childCallsAtBootstrap = transcriptCallCount(CHILD_SESSION_ID);

      // Visible page: the fallback interval refreshes root and descendants,
      // and keeps doing so on the next interval.
      await waitUntil(() => transcriptCallCount("session-1") === rootCallsAtBootstrap + 1, 8000);
      await waitUntil(() => transcriptCallCount(CHILD_SESSION_ID) === childCallsAtBootstrap + 1, 2000);
      await waitUntil(() => transcriptCallCount("session-1") === rootCallsAtBootstrap + 2, 8000);
    });

    it("does not issue periodic transcript requests while the page is hidden", async () => {
      withChildSession();
      render(<TeamRunPageClient />);
      await waitForBootstrapTranscripts();

      // Sanity check first: visible-page polling is active.
      const visibleCalls = transcriptCallCount("session-1");
      await waitUntil(() => transcriptCallCount("session-1") === visibleCalls + 1, 8000);

      const rootCalls = transcriptCallCount("session-1");
      const childCalls = transcriptCallCount(CHILD_SESSION_ID);

      setDocumentVisibility("hidden");
      await advance(16_000);

      expect(transcriptCallCount("session-1")).toBe(rootCalls);
      expect(transcriptCallCount(CHILD_SESSION_ID)).toBe(childCalls);
    });

    it("requests an immediate refresh when the page becomes visible or the window is focused", async () => {
      withChildSession();
      render(<TeamRunPageClient />);
      await waitForBootstrapTranscripts();

      // Hidden -> visible: one immediate queued refresh.
      setDocumentVisibility("hidden");
      await advance(6_000);
      const rootCallsBeforeVisible = transcriptCallCount("session-1");
      setDocumentVisibility("visible");
      await waitUntil(() => transcriptCallCount("session-1") === rootCallsBeforeVisible + 1, 2000);
      await waitUntil(() => transcriptCallCount(CHILD_SESSION_ID) >= 2, 2000);

      // Window focus: another immediate queued refresh.
      const rootCallsBeforeFocus = transcriptCallCount("session-1");
      window.dispatchEvent(new Event("focus"));
      await waitUntil(() => transcriptCallCount("session-1") === rootCallsBeforeFocus + 1, 2000);
    });

    it("coalesces repeated refresh triggers while a transcript request is in flight", async () => {
      withChildSession();
      render(<TeamRunPageClient />);
      await waitForBootstrapTranscripts();

      // Hold the next transcript round in flight.
      const rootInFlight = createDeferred<Response>();
      const childInFlight = createDeferred<Response>();
      transcriptResponders.set("session-1", () => rootInFlight.promise);
      transcriptResponders.set(CHILD_SESSION_ID, () => childInFlight.promise);

      window.dispatchEvent(new Event("focus"));
      await waitUntil(() => transcriptCallCount("session-1") === 2);
      await waitUntil(() => transcriptCallCount(CHILD_SESSION_ID) === 2);

      // More triggers arrive while the request is in flight: interval tick
      // plus repeated focus events. Nothing new starts in the meantime.
      window.dispatchEvent(new Event("focus"));
      await advance(5_500);
      window.dispatchEvent(new Event("focus"));
      await settle();
      expect(transcriptCallCount("session-1")).toBe(2);
      expect(transcriptCallCount(CHILD_SESSION_ID)).toBe(2);

      rootInFlight.resolve(okJsonResponse({ history: [], messages: [] }));
      childInFlight.resolve(okJsonResponse({ history: [], messages: [] }));

      // Exactly ONE coalesced follow-up round for the queued duplicates.
      await waitUntil(() => transcriptCallCount("session-1") === 3, 2000);
      await waitUntil(() => transcriptCallCount(CHILD_SESSION_ID) === 3, 2000);
      await advance(3_000);
      expect(transcriptCallCount("session-1")).toBe(3);
      expect(transcriptCallCount(CHILD_SESSION_ID)).toBe(3);
    });

    it("cleans up the previous run's timer and only refreshes the new run after switching Team Runs", async () => {
      withChildSession();
      const { rerender } = render(<TeamRunPageClient />);
      await waitForBootstrapTranscripts();

      mockTeamRunParams.sessionId = "session-2";
      rerender(<TeamRunPageClient />);

      // Run B bootstraps its own transcript.
      await waitUntil(() => transcriptCallCount("session-2") >= 1, 6000);
      await settle();

      const rootACalls = transcriptCallCount("session-1");
      const childCalls = transcriptCallCount(CHILD_SESSION_ID);
      const rootBCalls = transcriptCallCount("session-2");

      // Several intervals pass: only run B's session is refreshed.
      await waitUntil(() => transcriptCallCount("session-2") === rootBCalls + 1, 8000);
      await advance(6_000);

      expect(transcriptCallCount("session-1")).toBe(rootACalls);
      expect(transcriptCallCount(CHILD_SESSION_ID)).toBe(childCalls);
      expect(transcriptCallCount("session-2")).toBeGreaterThanOrEqual(rootBCalls + 1);
    });

    it("never erases a newer root SSE message with an older transcript response", async () => {
      transcriptResponders.set(
        "session-1",
        () => Promise.resolve(okJsonResponse({ history: [], messages: persistedSnapshotMessages() })),
      );
      const { rerender } = render(<TeamRunPageClient />);
      await waitUntil(() => currentLeadMessageTexts().includes("persisted snapshot"));

      const staleResponse = await holdNextRootTranscript(2);
      await pushLiveRootSseChunk(rerender);

      // The older snapshot resolves only now; it must not roll back the SSE content.
      staleResponse.resolve(okJsonResponse({ history: [], messages: persistedSnapshotMessages() }));
      await settle();
      await advance(300);

      expect(currentLeadMessageTexts()).toContain("live sse chunk");
      expect(currentLeadMessageTexts()).not.toContain("persisted snapshot");
    });

    it("queues a convergence refresh after skipping a stale root snapshot", async () => {
      transcriptResponders.set(
        "session-1",
        () => Promise.resolve(okJsonResponse({ history: [], messages: [] })),
      );
      const { rerender } = render(<TeamRunPageClient />);
      await waitForBootstrapTranscripts();

      const staleResponse = await holdNextRootTranscript(2);
      await pushLiveRootSseChunk(rerender);

      staleResponse.resolve(okJsonResponse({ history: [], messages: [] }));
      await settle();

      // The skipped stale snapshot schedules a later root refresh so durable
      // state can converge after the live burst.
      await waitUntil(() => transcriptCallCount("session-1") === 3, 6000);
    });

    it("keeps the last successfully rendered messages when an automatic refresh fails", async () => {
      transcriptResponders.set(
        "session-1",
        () => Promise.resolve(okJsonResponse({ history: [], messages: persistedSnapshotMessages() })),
      );
      render(<TeamRunPageClient />);
      await waitUntil(() => currentLeadMessageTexts().includes("persisted snapshot"));

      // The next automatic refresh fails hard.
      transcriptResponders.set("session-1", () => Promise.reject(new Error("network down")));
      window.dispatchEvent(new Event("focus"));
      await waitUntil(() => transcriptCallCount("session-1") === 2);
      await settle();

      // Existing messages are preserved — never cleared by a failed refresh.
      expect(currentLeadMessageTexts()).toContain("persisted snapshot");

      // The following interval retry keeps the last good snapshot too.
      await waitUntil(() => transcriptCallCount("session-1") === 3, 8000);
      await settle();
      expect(currentLeadMessageTexts()).toContain("persisted snapshot");
    });
  });
});
