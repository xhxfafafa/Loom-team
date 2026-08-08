import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeleteTeamRunDialog, TEAM_RUN_DELETE_CONFIRM_TOKEN } from "../delete-team-run-dialog";

const { mockDesktopAwareFetch } = vi.hoisted(() => ({
  mockDesktopAwareFetch: vi.fn(),
}));

vi.mock("@/client/utils/diagnostics", () => ({
  desktopAwareFetch: mockDesktopAwareFetch,
}));

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: {
      common: {
        cancel: "Cancel",
        loading: "Loading...",
      },
      team: {
        deleteTeam: "Delete Team Run",
        deleteDialogTitle: "Delete Team Run",
        deleteDialogWarning:
          "This stops all agents and deletes cards, sessions and private run data. This cannot be undone.",
        deleteDialogActiveWarning: "{count} agents are still running and will be stopped.",
        deleteDialogRunnerBlocked:
          "This team run contains runner-mode sessions that cannot be stopped locally.",
        deleteDialogConfirmHint: 'Type "{token}" or the exact team name to confirm.',
        deleteDialogConfirmPlaceholder: "DELETE",
        deleteDialogPreviewLoading: "Calculating impact...",
        deleteDialogPreviewFailed: "Could not load the deletion preview.",
        deleteDialogStatsSessions: "Sessions",
        deleteDialogStatsActiveAgents: "Active agents",
        deleteDialogStatsKanbanCards: "Kanban cards",
        deleteDialogStatsArtifacts: "Artifacts",
        deleteDialogStatsWorktrees: "Worktrees",
        deleteDialogStatsNotes: "Notes",
        deleteDialogStatsBackgroundTasks: "Background tasks",
        deleteDialogPreservedHint: "Shared items are preserved.",
        deleteFailed: "Failed to delete Team Run",
        deleteErrorNotFound: "Team run not found",
        deleteErrorNotTeamRoot: "Not a team run root",
        deleteErrorWorkspaceMismatch: "Workspace mismatch",
        deleteErrorRunnerUnsupported: "Runner sessions present",
        deleteErrorStopFailed: "Could not stop agents",
        unnamedRun: "Unnamed Team run",
      },
    },
  }),
}));

const preview = {
  rootSessionId: "root-1",
  teamName: "Team - Alpha",
  workspaceId: "ws-1",
  counts: {
    sessions: 3,
    activeAgents: 1,
    kanbanCards: 2,
    artifacts: 1,
    worktrees: 1,
    notes: 0,
    backgroundTasks: 0,
    preservedSharedKanbanCards: 1,
    preservedSharedWorktrees: 0,
  },
  hasRunnerSessions: false,
};

const deleteResult = {
  rootSessionId: "root-1",
  teamName: "Team - Alpha",
  workspaceId: "ws-1",
  deleted: {
    agentsStopped: 1,
    sessions: 3,
    kanbanCards: 2,
    artifacts: 1,
    worktrees: 1,
    notes: 0,
    backgroundTasks: 0,
  },
  preserved: { sharedKanbanCards: 1, sharedWorktrees: 0 },
  warnings: [],
};

function renderDialog() {
  const onDeleted = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <DeleteTeamRunDialog
      workspaceId="ws-1"
      teamRun={{ sessionId: "root-1", name: "Team - Alpha" }}
      onClose={onClose}
      onDeleted={onDeleted}
    />,
  );
  return { onDeleted, onClose, ...utils };
}

async function waitForPreview() {
  await screen.findByText("Sessions");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDesktopAwareFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/preview")) {
      return { ok: true, json: async () => preview } as Response;
    }
    return { ok: true, json: async () => ({ result: deleteResult }) } as Response;
  });
});

describe("DeleteTeamRunDialog", () => {
  it("loads the preview and requires explicit confirmation before deleting", async () => {
    const { onDeleted, onClose } = renderDialog();

    await waitForPreview();
    expect(mockDesktopAwareFetch).toHaveBeenCalledWith(
      "/api/team-runs/root-1/preview?workspaceId=ws-1",
      expect.objectContaining({ cache: "no-store" }),
    );

    // Impact stats + active-agent warning from the preview.
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("1 agents are still running and will be stopped.")).toBeTruthy();
    expect(screen.getByText("Shared items are preserved.")).toBeTruthy();

    const confirmButton = screen.getByRole("button", { name: "Delete Team Run" });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);

    const input = screen.getByPlaceholderText("DELETE");
    fireEvent.change(input, { target: { value: "wrong" } });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: TEAM_RUN_DELETE_CONFIRM_TOKEN } });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(confirmButton);
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(deleteResult));

    expect(mockDesktopAwareFetch).toHaveBeenCalledWith(
      "/api/team-runs/root-1?workspaceId=ws-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("accepts the exact team name as confirmation", async () => {
    renderDialog();
    await waitForPreview();

    const confirmButton = screen.getByRole("button", { name: "Delete Team Run" });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("DELETE"), {
      target: { value: "Team - Alpha" },
    });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("cancels without deleting", async () => {
    const { onClose } = renderDialog();
    await waitForPreview();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockDesktopAwareFetch).toHaveBeenCalledTimes(1); // preview only
  });

  it("blocks deletion while runner sessions are present", async () => {
    mockDesktopAwareFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ ...preview, hasRunnerSessions: true }),
    } as Response));

    renderDialog();
    await waitForPreview();

    expect(screen.getByText("This team run contains runner-mode sessions that cannot be stopped locally.")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("DELETE"), {
      target: { value: TEAM_RUN_DELETE_CONFIRM_TOKEN },
    });
    expect((screen.getByRole("button", { name: "Delete Team Run" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a localized error when the delete request fails", async () => {
    const { onDeleted } = renderDialog();
    await waitForPreview();

    mockDesktopAwareFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/preview")) {
        return { ok: true, json: async () => preview } as Response;
      }
      return {
        ok: false,
        json: async () => ({ error: { code: "TEAM_RUN_STOP_FAILED", message: "nope" } }),
      } as Response;
    });

    fireEvent.change(screen.getByPlaceholderText("DELETE"), {
      target: { value: TEAM_RUN_DELETE_CONFIRM_TOKEN },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete Team Run" }));

    await screen.findByText("Could not stop agents");
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("shows a preview error banner when the preview request fails", async () => {
    mockDesktopAwareFetch.mockImplementation(async () => ({
      ok: false,
      json: async () => ({ error: { code: "TEAM_RUN_NOT_TEAM_ROOT" } }),
    } as Response));

    renderDialog();

    await screen.findByText("Not a team run root");
    expect((screen.getByRole("button", { name: "Delete Team Run" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
