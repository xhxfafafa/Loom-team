"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { DesktopAppShell } from "@/client/components/desktop-app-shell";
import { WorkspaceSwitcher } from "@/client/components/workspace-switcher";
import { useWorkspaces } from "@/client/hooks/use-workspaces";
import { useTranslation } from "@/i18n";
import { desktopAwareFetch } from "@/client/utils/diagnostics";
import { resolveApiPath } from "@/client/config/backend";

// ---------------------------------------------------------------------------
// Types (mirrors src/core/delivery/delivery-report.ts)
// ---------------------------------------------------------------------------

interface DeliveryEvidence {
  type: string;
  summary: string;
}

interface DeliveryCompletedTask {
  taskId: string;
  title: string;
  verificationVerdict?: string;
  evidence: DeliveryEvidence[];
}

interface DeliveryOutstandingTask {
  taskId: string;
  title: string;
  status: string;
  blocker?: string;
}

interface DeliveryRisk {
  taskId?: string;
  description: string;
}

interface DeliveryHowToRun {
  command: string;
  description?: string;
}

interface DeliveryRecentRun {
  id: string;
  summary: string;
}

interface DeliveryProgress {
  total: number;
  done: number;
  inProgress: number;
  review: number;
  blocked: number;
}

interface DeliveryAudit {
  traceCount: number;
  tracePagePath: string;
  recentRuns: DeliveryRecentRun[];
}

interface DeliveryReport {
  workspaceId: string;
  generatedAt: string;
  progress: DeliveryProgress;
  completed: DeliveryCompletedTask[];
  outstanding: DeliveryOutstandingTask[];
  risks: DeliveryRisk[];
  howToRun: DeliveryHowToRun[];
  audit: DeliveryAudit;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DeliveryPageClient() {
  const params = useParams();
  const router = useRouter();
  const { t } = useTranslation();
  const workspacesHook = useWorkspaces();

  const rawWorkspaceId = params.workspaceId as string;
  const workspaceId =
    rawWorkspaceId === "__placeholder__" && typeof window !== "undefined"
      ? (window.location.pathname.match(/^\/workspace\/([^/]+)/)?.[1] ?? rawWorkspaceId)
      : rawWorkspaceId;

  const [report, setReport] = useState<DeliveryReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = resolveApiPath(`/delivery/${encodeURIComponent(workspaceId)}`);
      const response = await desktopAwareFetch(url);
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(body || `HTTP ${response.status}`);
      }
      const data = (await response.json()) as DeliveryReport;
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  // Workspace switcher handlers
  const workspace = workspacesHook.workspaces.find((w) => w.id === workspaceId);
  const activeWorkspaceTitle = workspace?.title ?? (workspaceId === "default" ? t.common.workspace : workspaceId);

  const handleWorkspaceSelect = useCallback((nextWorkspaceId: string) => {
    router.push(`/workspace/${nextWorkspaceId}/delivery`);
  }, [router]);

  const handleWorkspaceCreate = useCallback(async (title: string) => {
    const result = await workspacesHook.createWorkspace(title);
    if (result) {
      router.push(`/workspace/${result.id}/delivery`);
    }
  }, [router, workspacesHook]);

  const handleCopyCommand = useCallback(async (command: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    } catch {
      // Ignore clipboard errors
    }
  }, []);

  return (
    <DesktopAppShell
      workspaceId={workspaceId}
      workspaceTitle={activeWorkspaceTitle}
      workspaceSwitcher={(
        <WorkspaceSwitcher
          workspaces={workspacesHook.workspaces}
          activeWorkspaceId={workspaceId}
          activeWorkspaceTitle={activeWorkspaceTitle}
          onSelect={handleWorkspaceSelect}
          onCreate={handleWorkspaceCreate}
          loading={workspacesHook.loading}
          compact
          desktop
        />
      )}
    >
      <div className="flex h-full flex-col overflow-hidden bg-desktop-bg-primary">
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
          {/* Header */}
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-desktop-text-primary">
              {t.delivery.title}
            </h1>
            <p className="mt-1 text-sm text-desktop-text-secondary">
              {t.delivery.subtitle}
            </p>
          </div>

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-12 text-desktop-text-muted">
              <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {t.delivery.loading}
            </div>
          )}

          {/* Error */}
          {error && !loading && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              <p>{t.delivery.errorLoading}</p>
              <p className="mt-1 text-xs text-desktop-text-muted">{error}</p>
              <button
                type="button"
                onClick={fetchReport}
                className="mt-2 rounded border border-desktop-border px-3 py-1 text-xs text-desktop-text-secondary hover:bg-desktop-bg-secondary"
              >
                {t.delivery.retry}
              </button>
            </div>
          )}

          {/* Report */}
          {report && !loading && (
            <div className="space-y-6">
              {/* Progress Overview */}
              <ProgressSection progress={report.progress} t={t.delivery.progress} />

              {/* Completed Work */}
              <CompletedSection
                completed={report.completed}
                t={t.delivery.completed}
              />

              {/* Outstanding Work */}
              <OutstandingSection
                outstanding={report.outstanding}
                t={t.delivery.outstanding}
              />

              {/* Risks */}
              <RisksSection risks={report.risks} t={t.delivery.risks} />

              {/* How to Run */}
              <HowToRunSection
                howToRun={report.howToRun}
                t={t.delivery.howToRun}
                copiedIdx={copiedIdx}
                onCopy={handleCopyCommand}
              />

              {/* Audit Trail */}
              <AuditSection
                audit={report.audit}
                workspaceId={workspaceId}
                t={t.delivery.audit}
              />

              {/* Footer */}
              <p className="text-xs text-desktop-text-muted pt-2">
                {t.delivery.generatedAt}:{" "}
                {new Date(report.generatedAt).toLocaleString()}
              </p>
            </div>
          )}
        </div>
      </div>
    </DesktopAppShell>
  );
}

// ---------------------------------------------------------------------------
// Section Components
// ---------------------------------------------------------------------------

type TranslationValue = Record<string, string>;

function SectionCard({
  title,
  children,
  empty,
}: {
  title: string;
  children: React.ReactNode;
  empty?: boolean;
}) {
  return (
    <section className="rounded-lg border border-desktop-border bg-desktop-bg-secondary p-4">
      <h2 className="mb-3 text-sm font-semibold text-desktop-text-primary">
        {title}
      </h2>
      {empty ? (
        <p className="text-xs text-desktop-text-muted">{children}</p>
      ) : (
        children
      )}
    </section>
  );
}

function ProgressSection({
  progress,
  t,
}: {
  progress: DeliveryProgress;
  t: TranslationValue;
}) {
  const items = [
    { label: t.total, value: progress.total, color: "text-desktop-text-primary" },
    { label: t.done, value: progress.done, color: "text-emerald-400" },
    { label: t.inProgress, value: progress.inProgress, color: "text-amber-400" },
    { label: t.review, value: progress.review, color: "text-sky-400" },
    { label: t.blocked, value: progress.blocked, color: "text-red-400" },
  ];

  const total = progress.total || 1;
  const donePct = Math.round((progress.done / total) * 100);

  return (
    <SectionCard title={t.title}>
      <div className="mb-3 h-2 rounded-full bg-desktop-bg-primary overflow-hidden">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all"
          style={{ width: `${donePct}%` }}
        />
      </div>
      <div className="grid grid-cols-5 gap-3">
        {items.map((item) => (
          <div key={item.label} className="text-center">
            <div className={`text-2xl font-bold ${item.color}`}>
              {item.value}
            </div>
            <div className="text-xs text-desktop-text-muted">{item.label}</div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function CompletedSection({
  completed,
  t,
}: {
  completed: DeliveryCompletedTask[];
  t: TranslationValue & { verdict: string; evidence: string; noEvidence: string };
}) {
  if (completed.length === 0) {
    return <SectionCard title={t.title} empty>{t.empty}</SectionCard>;
  }

  return (
    <SectionCard title={`${t.title} (${completed.length})`}>
      <ul className="space-y-2">
        {completed.map((task) => (
          <li
            key={task.taskId}
            className="rounded border border-desktop-border/50 px-3 py-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-desktop-text-primary">
                {task.title}
              </span>
              {task.verificationVerdict && (
                <span className="ml-2 rounded bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-400">
                  {t.verdict}: {task.verificationVerdict}
                </span>
              )}
            </div>
            {task.evidence.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {task.evidence.map((ev, i) => (
                  <li
                    key={i}
                    className="text-xs text-desktop-text-secondary"
                  >
                    <span className="inline-block min-w-[8rem] text-desktop-text-muted">
                      {ev.type}
                    </span>{" "}
                    — {ev.summary}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-desktop-text-muted">
                {t.noEvidence}
              </p>
            )}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function OutstandingSection({
  outstanding,
  t,
}: {
  outstanding: DeliveryOutstandingTask[];
  t: TranslationValue & { blocker: string };
}) {
  if (outstanding.length === 0) {
    return <SectionCard title={t.title} empty>{t.empty}</SectionCard>;
  }

  return (
    <SectionCard title={`${t.title} (${outstanding.length})`}>
      <ul className="space-y-1">
        {outstanding.map((task) => (
          <li
            key={task.taskId}
            className="flex items-start gap-2 rounded border border-desktop-border/50 px-3 py-2 text-sm"
          >
            <StatusBadge status={task.status} />
            <div className="flex-1 min-w-0">
              <span className="text-desktop-text-primary">{task.title}</span>
              {task.blocker && (
                <p className="mt-0.5 text-xs text-red-400">
                  {t.blocker}: {task.blocker}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    PENDING: "bg-slate-500/20 text-slate-300",
    IN_PROGRESS: "bg-amber-500/20 text-amber-300",
    REVIEW_REQUIRED: "bg-sky-500/20 text-sky-300",
    BLOCKED: "bg-red-500/20 text-red-300",
    NEEDS_FIX: "bg-orange-500/20 text-orange-300",
  };
  const color = colorMap[status] ?? "bg-slate-500/20 text-slate-300";
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${color}`}>
      {status}
    </span>
  );
}

function RisksSection({
  risks,
  t,
}: {
  risks: DeliveryRisk[];
  t: TranslationValue;
}) {
  if (risks.length === 0) {
    return <SectionCard title={t.title} empty>{t.empty}</SectionCard>;
  }

  return (
    <SectionCard title={`${t.title} (${risks.length})`}>
      <ul className="space-y-1">
        {risks.map((risk, i) => (
          <li
            key={i}
            className="flex items-start gap-2 text-sm text-desktop-text-secondary"
          >
            <span className="mt-0.5 text-amber-400">⚠</span>
            <span>{risk.description}</span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function HowToRunSection({
  howToRun,
  t,
  copiedIdx,
  onCopy,
}: {
  howToRun: DeliveryHowToRun[];
  t: TranslationValue & { copy: string; copied: string };
  copiedIdx: number | null;
  onCopy: (cmd: string, idx: number) => void;
}) {
  if (howToRun.length === 0) {
    return <SectionCard title={t.title} empty>{t.empty}</SectionCard>;
  }

  return (
    <SectionCard title={t.title}>
      <ul className="space-y-1">
        {howToRun.map((entry, idx) => (
          <li
            key={idx}
            className="flex items-center gap-2 rounded border border-desktop-border/50 px-3 py-1.5"
          >
            <code className="flex-1 text-xs text-desktop-text-primary font-mono">
              {entry.command}
            </code>
            {entry.description && (
              <span className="text-xs text-desktop-text-muted shrink-0">
                {entry.description}
              </span>
            )}
            <button
              type="button"
              onClick={() => onCopy(entry.command, idx)}
              className="shrink-0 rounded border border-desktop-border px-2 py-0.5 text-xs text-desktop-text-secondary hover:bg-desktop-bg-primary"
            >
              {copiedIdx === idx ? t.copied : t.copy}
            </button>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function AuditSection({
  audit,
  workspaceId,
  t,
}: {
  audit: DeliveryAudit;
  workspaceId: string;
  t: TranslationValue & { recentRuns: string; noRuns: string; viewTraces: string; traceCount: string };
}) {
  return (
    <SectionCard title={t.title}>
      <div className="mb-2 flex items-center gap-3 text-sm">
        <span className="text-desktop-text-primary">
          {audit.traceCount} {t.traceCount}
        </span>
        <a
          href={`/workspace/${workspaceId}/traces`}
          className="text-desktop-accent hover:underline text-xs"
        >
          {t.viewTraces} →
        </a>
      </div>
      {audit.recentRuns.length > 0 ? (
        <>
          <h3 className="text-xs font-medium text-desktop-text-secondary mb-1">
            {t.recentRuns}
          </h3>
          <ul className="space-y-0.5">
            {audit.recentRuns.map((run) => (
              <li
                key={run.id}
                className="text-xs text-desktop-text-muted"
              >
                {run.summary}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-xs text-desktop-text-muted">{t.noRuns}</p>
      )}
    </SectionCard>
  );
}
