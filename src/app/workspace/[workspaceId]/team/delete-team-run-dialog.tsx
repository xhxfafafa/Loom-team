"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useTranslation } from "@/i18n";
import { desktopAwareFetch } from "@/client/utils/diagnostics";

/** Confirmation token accepted instead of the exact Team name. */
export const TEAM_RUN_DELETE_CONFIRM_TOKEN = "DELETE";

export interface TeamRunDeletionPreview {
  rootSessionId: string;
  teamName: string;
  workspaceId: string;
  counts: {
    sessions: number;
    activeAgents: number;
    kanbanCards: number;
    artifacts: number;
    worktrees: number;
    notes: number;
    backgroundTasks: number;
    preservedSharedKanbanCards: number;
    preservedSharedWorktrees: number;
  };
  hasRunnerSessions: boolean;
}

export interface TeamRunDeletionResultSummary {
  rootSessionId: string;
  teamName: string;
  workspaceId: string;
  deleted: {
    agentsStopped: number;
    sessions: number;
    kanbanCards: number;
    artifacts: number;
    worktrees: number;
    notes: number;
    backgroundTasks: number;
  };
  preserved: {
    sharedKanbanCards: number;
    sharedWorktrees: number;
  };
  warnings: string[];
}

export interface TeamRunTarget {
  sessionId: string;
  name?: string;
}

interface DeleteTeamRunDialogProps {
  workspaceId: string;
  teamRun: TeamRunTarget | null;
  onClose: () => void;
  onDeleted: (result: TeamRunDeletionResultSummary) => void;
}

const ERROR_MESSAGE_KEYS: Record<string, "deleteErrorNotFound" | "deleteErrorNotTeamRoot" | "deleteErrorWorkspaceMismatch" | "deleteErrorRunnerUnsupported" | "deleteErrorStopFailed"> = {
  TEAM_RUN_NOT_FOUND: "deleteErrorNotFound",
  TEAM_RUN_NOT_TEAM_ROOT: "deleteErrorNotTeamRoot",
  TEAM_RUN_WORKSPACE_MISMATCH: "deleteErrorWorkspaceMismatch",
  TEAM_RUN_RUNNER_UNSUPPORTED: "deleteErrorRunnerUnsupported",
  TEAM_RUN_STOP_FAILED: "deleteErrorStopFailed",
};

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const data = (await response.json()) as { error?: { code?: string } };
    return data?.error?.code ?? null;
  } catch {
    return null;
  }
}

export function DeleteTeamRunDialog({ workspaceId, teamRun, onClose, onDeleted }: DeleteTeamRunDialogProps) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<TeamRunDeletionPreview | null>(null);
  const [previewErrorCode, setPreviewErrorCode] = useState<string | null>(null);
  const [previewLoadFailed, setPreviewLoadFailed] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteErrorCode, setDeleteErrorCode] = useState<string | null>(null);

  const open = teamRun !== null;

  useEffect(() => {
    if (!open || !teamRun) return undefined;

    const controller = new AbortController();
    setPreview(null);
    setPreviewErrorCode(null);
    setPreviewLoadFailed(false);
    setConfirmText("");
    setDeleteErrorCode(null);

    (async () => {
      try {
        const res = await desktopAwareFetch(
          `/api/team-runs/${encodeURIComponent(teamRun.sessionId)}/preview?workspaceId=${encodeURIComponent(workspaceId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (!res.ok) {
          setPreviewErrorCode((await readErrorCode(res)) ?? "INTERNAL");
          return;
        }
        const data = (await res.json()) as TeamRunDeletionPreview;
        if (controller.signal.aborted) return;
        setPreview(data);
      } catch {
        if (!controller.signal.aborted) setPreviewLoadFailed(true);
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, teamRun?.sessionId, workspaceId]);

  const displayName = preview?.teamName || teamRun?.name || t.team.unnamedRun;
  const confirmMatches = useMemo(() => {
    const normalized = confirmText.trim();
    if (!normalized) return false;
    return normalized === TEAM_RUN_DELETE_CONFIRM_TOKEN || normalized === (preview?.teamName ?? teamRun?.name ?? "").trim();
  }, [confirmText, preview?.teamName, teamRun?.name]);

  const runnerBlocked = preview?.hasRunnerSessions ?? false;
  const canDelete = open && !!preview && !runnerBlocked && confirmMatches && !isDeleting;

  const errorMessage = useCallback((code: string | null) => {
    const key = code ? ERROR_MESSAGE_KEYS[code] : undefined;
    return key ? t.team[key] : t.team.deleteFailed;
  }, [t]);

  const handleConfirm = useCallback(async () => {
    if (!canDelete || !teamRun) return;
    setIsDeleting(true);
    setDeleteErrorCode(null);
    try {
      const res = await desktopAwareFetch(
        `/api/team-runs/${encodeURIComponent(teamRun.sessionId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        setDeleteErrorCode(await readErrorCode(res));
        return;
      }
      const data = (await res.json()) as { result?: TeamRunDeletionResultSummary };
      if (data.result) {
        onDeleted(data.result);
      }
    } catch {
      setDeleteErrorCode(null);
    } finally {
      setIsDeleting(false);
    }
  }, [canDelete, onDeleted, teamRun, workspaceId]);

  if (!open) return null;

  const stats: Array<[string, number]> = preview ? [
    [t.team.deleteDialogStatsSessions, preview.counts.sessions],
    [t.team.deleteDialogStatsActiveAgents, preview.counts.activeAgents],
    [t.team.deleteDialogStatsKanbanCards, preview.counts.kanbanCards],
    [t.team.deleteDialogStatsArtifacts, preview.counts.artifacts],
    [t.team.deleteDialogStatsWorktrees, preview.counts.worktrees],
    [t.team.deleteDialogStatsNotes, preview.counts.notes],
    [t.team.deleteDialogStatsBackgroundTasks, preview.counts.backgroundTasks],
  ] : [];

  const preservedCount = preview
    ? preview.counts.preservedSharedKanbanCards + preview.counts.preservedSharedWorktrees
    : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      role="dialog"
      aria-modal="true"
      aria-label={t.team.deleteDialogTitle}
    >
      <div className="relative max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-[#1c1f2e] dark:bg-[#12141c]">
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/20">
              <TriangleAlert className="h-6 w-6 text-red-600 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t.team.deleteDialogTitle}</h3>
              <p className="mt-1 truncate text-sm font-medium text-slate-900 dark:text-slate-100">&quot;{displayName}&quot;</p>
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">
                {t.team.deleteDialogWarning}
              </p>
            </div>
          </div>

          {!preview && !previewErrorCode && !previewLoadFailed && (
            <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">{t.team.deleteDialogPreviewLoading}</p>
          )}

          {(previewErrorCode !== null || previewLoadFailed) && (
            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
              {previewErrorCode && ERROR_MESSAGE_KEYS[previewErrorCode]
                ? t.team[ERROR_MESSAGE_KEYS[previewErrorCode]]
                : t.team.deleteDialogPreviewFailed}
            </p>
          )}

          {preview ? (
            <>
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm dark:border-slate-700 dark:bg-[#0d1018]">
                {stats.map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-2">
                    <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
                    <dd className="font-semibold text-slate-900 dark:text-slate-100">{value}</dd>
                  </div>
                ))}
              </dl>

              {preview.counts.activeAgents > 0 && (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                  {t.team.deleteDialogActiveWarning.replace("{count}", String(preview.counts.activeAgents))}
                </p>
              )}

              {runnerBlocked && (
                <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
                  {t.team.deleteDialogRunnerBlocked}
                </p>
              )}

              {preservedCount > 0 && (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">{t.team.deleteDialogPreservedHint}</p>
              )}

              <label className="mt-4 block text-sm text-slate-600 dark:text-slate-300">
                {t.team.deleteDialogConfirmHint.replace("{token}", TEAM_RUN_DELETE_CONFIRM_TOKEN)}
                <input
                  type="text"
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                  placeholder={t.team.deleteDialogConfirmPlaceholder}
                  autoFocus
                  className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-200 dark:border-slate-600 dark:bg-[#0d1018] dark:text-slate-100 dark:focus:border-red-500 dark:focus:ring-red-900/40"
                />
              </label>
            </>
          ) : null}

          {deleteErrorCode !== null && (
            <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
              {errorMessage(deleteErrorCode)}
            </p>
          )}

          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isDeleting}
              className="flex-1 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-[#0d1018] dark:text-slate-300 dark:hover:bg-[#191c28]"
            >
              {t.common.cancel}
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={!canDelete || previewErrorCode !== null}
              className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-500 dark:hover:bg-red-600"
            >
              {isDeleting ? t.common.loading : t.team.deleteTeam}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
