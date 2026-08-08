"use client";
/**
 * PlanPageClient — Product Development Plan UI
 *
 * Loads the active goal, generates/reviews/confirms/rejects plans,
 * and shows the resulting sections. All strings via i18n.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DesktopAppShell } from "@/client/components/desktop-app-shell";
import { WorkspaceSwitcher } from "@/client/components/workspace-switcher";
import { useWorkspaces } from "@/client/hooks/use-workspaces";
import { useTranslation } from "@/i18n";
import { desktopAwareFetch } from "@/client/utils/diagnostics";
import { resolveApiPath } from "@/client/config/backend";
// ─── Types (mirror src/core/plan/dev-plan.ts) ─────────────────────────

interface DevPlanRisk {
  risk: string;
  mitigation?: string;
}

interface DevPlanUserStory {
  id: string;
  title: string;
  story: string;
  acceptanceCriteria: string[];
}

interface DevPlanTeamAllocation {
  role: string;
  responsibility: string;
}

interface DevPlanFeedbackEntry {
  at: string;
  note: string;
}

interface DevPlan {
  id: string;
  workspaceId: string;
  goalId: string;
  status: "draft" | "confirmed" | "rejected";
  scope: string[];
  nonGoals: string[];
  risks: DevPlanRisk[];
  userStories: DevPlanUserStory[];
  technicalApproach: string;
  teamAllocation: DevPlanTeamAllocation[];
  feedbackLog: DevPlanFeedbackEntry[];
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
}

interface ProductGoal {
  id: string;
  workspaceId: string;
  goalText: string;
  status: string;
}

// ─── Component ────────────────────────────────────────────────────────

interface PlanPageClientProps {
  workspaceId: string;
}

export function PlanPageClient({ workspaceId }: PlanPageClientProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const workspacesHook = useWorkspaces();

  const activeWorkspaceTitle =
    workspacesHook.workspaces.find((w) => w.id === workspaceId)?.title ?? workspaceId;

  const [goal, setGoal] = useState<ProductGoal | null>(null);
  const [plan, setPlan] = useState<DevPlan | null>(null);
  const [planSource, setPlanSource] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load active goal + latest plan for workspace
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const goalsRes = await desktopAwareFetch(
          resolveApiPath(`/api/goals?workspaceId=${encodeURIComponent(workspaceId)}`),
        );
        if (!goalsRes.ok) throw new Error(t.plan.errorLoading);
        const goalsData = (await goalsRes.json()) as { goals: ProductGoal[] };
        const goals = goalsData.goals ?? [];
        const active = goals.find((g) => g.status === "active") ?? goals[goals.length - 1] ?? null;
        if (cancelled) return;
        setGoal(active);

        if (active) {
          const plansRes = await desktopAwareFetch(
            resolveApiPath(`/api/plans?goalId=${encodeURIComponent(active.id)}`),
          );
          if (plansRes.ok) {
            const plansData = (await plansRes.json()) as { plans: DevPlan[] };
            const plans = plansData.plans ?? [];
            if (!cancelled && plans.length > 0) {
              // Pick latest confirmed, else latest
              const confirmed = plans.find((p) => p.status === "confirmed");
              setPlan(confirmed ?? plans[plans.length - 1]);
            }
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, t.plan.errorLoading]);

  const handleGenerate = useCallback(
    async (withFeedback?: string) => {
      if (!goal) return;
      setGenerating(true);
      setError(null);
      try {
        const res = await desktopAwareFetch(resolveApiPath("/api/plans"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            goalId: goal.id,
            feedback: withFeedback,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || t.plan.generationFailed);
        }
        const data = (await res.json()) as { plan: DevPlan; source?: string };
        setPlan(data.plan);
        setPlanSource(data.source ?? null);
        setFeedback("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setGenerating(false);
      }
    },
    [goal, workspaceId, t.plan.generationFailed],
  );

  const handleConfirm = useCallback(async () => {
    if (!plan) return;
    setConfirming(true);
    setError(null);
    try {
      const res = await desktopAwareFetch(
        resolveApiPath(`/api/plans/${plan.id}/confirm`),
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || t.plan.confirm.error);
      }
      const data = (await res.json()) as { plan?: DevPlan };
      if (data.plan) setPlan(data.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirming(false);
    }
  }, [plan, t.plan.confirm.error]);

  const handleReject = useCallback(async () => {
    if (!plan || !feedback.trim()) return;
    setRejecting(true);
    setError(null);
    try {
      const res = await desktopAwareFetch(
        resolveApiPath(`/api/plans/${plan.id}/reject`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ feedback: feedback.trim() }),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || t.plan.reject.error);
      }
      const data = (await res.json()) as { plan?: DevPlan };
      if (data.plan) setPlan(data.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRejecting(false);
    }
  }, [plan, feedback, t.plan.reject.error]);

  const statusBadgeClass = useMemo(() => {
    if (!plan) return "";
    switch (plan.status) {
      case "confirmed":
        return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300";
      case "rejected":
        return "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300";
      case "draft":
      default:
        return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    }
  }, [plan]);

  const statusLabel = useMemo(() => {
    if (!plan) return "";
    return t.plan.status[plan.status];
  }, [plan, t.plan.status]);

  const handleWorkspaceSelect = useCallback((nextWorkspaceId: string) => {
    router.push(`/workspace/${nextWorkspaceId}/plan`);
  }, [router]);

  const handleWorkspaceCreate = useCallback(async (title: string) => {
    const workspace = await workspacesHook.createWorkspace(title);
    if (workspace) {
      router.push(`/workspace/${workspace.id}/plan`);
    }
  }, [router, workspacesHook]);

  return (
    <DesktopAppShell
      workspaceId={workspaceId}
      workspaceTitle={activeWorkspaceTitle}
      workspaceSwitcher={
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
      }
    >
      <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <header className="space-y-2">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">{t.plan.title}</h1>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {t.plan.subtitle}
              </p>
            </div>
            {plan && (
              <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass}`}>
                {statusLabel}
              </span>
            )}
          </div>
        </header>

        {error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-800/60 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        )}

        {loading && (
          <div className="py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
            {t.plan.loading}
          </div>
        )}

        {!loading && !goal && (
          <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
            <h2 className="text-lg font-medium">{t.plan.noActiveGoalTitle}</h2>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {t.plan.noActiveGoalDescription}
            </p>
            <Link
              href={`/workspace/${workspaceId}/goal`}
              className="mt-4 inline-block rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              {t.plan.goToGoal}
            </Link>
          </div>
        )}

        {!loading && goal && !plan && (
          <div className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm text-zinc-600 dark:text-zinc-300">
              <strong>{goal.goalText}</strong>
            </p>
            <button
              type="button"
              onClick={() => handleGenerate()}
              disabled={generating}
              className="mt-4 inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {generating ? t.plan.generating : t.plan.generatePlan}
            </button>
          </div>
        )}

        {!loading && plan && (
          <div className="space-y-6">
            {/* Action bar */}
            <div className="flex flex-wrap items-center gap-2">
              {plan.status === "draft" && (
                <>
                  <button
                    type="button"
                    onClick={handleConfirm}
                    disabled={confirming || rejecting}
                    className="inline-flex items-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {confirming ? t.plan.confirm.confirming : t.plan.confirm.button}
                  </button>
                  <button
                    type="button"
                    onClick={handleReject}
                    disabled={rejecting || confirming || !feedback.trim()}
                    className="inline-flex items-center rounded-md border border-rose-300 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-950/40"
                  >
                    {rejecting ? t.plan.reject.rejecting : t.plan.reject.button}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleGenerate()}
                    disabled={generating || confirming || rejecting}
                    className="inline-flex items-center rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
                  >
                    {generating ? t.plan.generating : t.plan.regeneratePlan}
                  </button>
                </>
              )}
              {plan.status === "rejected" && (
                <>
                  <button
                    type="button"
                    onClick={() => handleGenerate(feedback)}
                    disabled={generating || !feedback.trim()}
                    className="inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {generating ? t.plan.generating : t.plan.regenerateWithFeedback}
                  </button>
                </>
              )}
              {plan.status === "confirmed" && (
                <Link
                  href={`/workspace/${workspaceId}/kanban`}
                  className="inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
                >
                  {t.plan.confirm.goToKanban}
                </Link>
              )}
              {planSource && (
                <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">
                  {t.plan.sourceLabel}: {planSource === "llm" ? t.plan.sourceLlm : t.plan.sourceFallback}
                </span>
              )}
            </div>

            {plan.status === "confirmed" && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300">
                <p className="font-medium">{t.plan.confirm.successTitle}</p>
                <p className="mt-1 text-emerald-700 dark:text-emerald-400">
                  {t.plan.confirm.successDescription}
                </p>
              </div>
            )}

            {plan.status === "rejected" && (
              <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-800/60 dark:bg-rose-950/40 dark:text-rose-300">
                <p className="font-medium">{t.plan.reject.successTitle}</p>
              </div>
            )}

            {/* Feedback input (for draft / rejected) */}
            {(plan.status === "draft" || plan.status === "rejected") && (
              <div className="space-y-2">
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  {t.plan.feedback.label}
                </label>
                <textarea
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder={t.plan.feedback.placeholder}
                  rows={3}
                  className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </div>
            )}

            {/* Scope */}
            <PlanSection title={t.plan.sections.scope}>
              {plan.scope.length > 0 ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
                  {plan.scope.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              ) : (
                <EmptyLine />
              )}
            </PlanSection>

            {/* Non-goals */}
            <PlanSection title={t.plan.sections.nonGoals}>
              {plan.nonGoals.length > 0 ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
                  {plan.nonGoals.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              ) : (
                <EmptyLine />
              )}
            </PlanSection>

            {/* Risks */}
            <PlanSection title={t.plan.sections.risks}>
              {plan.risks.length > 0 ? (
                <div className="space-y-2">
                  {plan.risks.map((r, i) => (
                    <div
                      key={i}
                      className="rounded-md border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                    >
                      <p>
                        <span className="font-medium">{t.plan.risks.risk}:</span> {r.risk}
                      </p>
                      {r.mitigation && (
                        <p className="mt-1 text-zinc-500 dark:text-zinc-400">
                          <span className="font-medium">{t.plan.risks.mitigation}:</span>{" "}
                          {r.mitigation}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyLine>{t.plan.risks.none}</EmptyLine>
              )}
            </PlanSection>

            {/* User stories */}
            <PlanSection title={t.plan.sections.userStories}>
              {plan.userStories.length > 0 ? (
                <div className="space-y-3">
                  {plan.userStories.map((s) => (
                    <div
                      key={s.id}
                      className="rounded-md border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                    >
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                          {s.id}
                        </span>
                        <span className="font-medium">{s.title}</span>
                      </div>
                      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
                        <span className="font-medium">{t.plan.stories.story}:</span> {s.story}
                      </p>
                      {s.acceptanceCriteria.length > 0 && (
                        <div className="mt-2">
                          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                            {t.plan.stories.acceptanceCriteria}
                          </p>
                          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-zinc-700 dark:text-zinc-300">
                            {s.acceptanceCriteria.map((c, i) => (
                              <li key={i}>{c}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyLine />
              )}
            </PlanSection>

            {/* Technical approach */}
            <PlanSection title={t.plan.sections.technicalApproach}>
              {plan.technicalApproach ? (
                <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
                  {plan.technicalApproach}
                </p>
              ) : (
                <EmptyLine />
              )}
            </PlanSection>

            {/* Team allocation */}
            <PlanSection title={t.plan.sections.teamAllocation}>
              {plan.teamAllocation.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                        <th className="py-2 pr-4">{t.plan.team.role}</th>
                        <th className="py-2">{t.plan.team.responsibility}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.teamAllocation.map((a, i) => (
                        <tr
                          key={i}
                          className="border-b border-zinc-100 text-zinc-700 last:border-0 dark:border-zinc-800 dark:text-zinc-300"
                        >
                          <td className="py-2 pr-4 font-medium">{a.role}</td>
                          <td className="py-2">{a.responsibility}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyLine />
              )}
            </PlanSection>

            {/* Feedback log */}
            {plan.feedbackLog.length > 0 && (
              <PlanSection title={t.plan.sections.feedbackLog}>
                <div className="space-y-2">
                  {plan.feedbackLog.map((f, i) => (
                    <div
                      key={i}
                      className="rounded-md border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                    >
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        {new Date(f.at).toLocaleString()}
                      </p>
                      <p className="mt-1 text-zinc-700 dark:text-zinc-300">{f.note}</p>
                    </div>
                  ))}
                </div>
              </PlanSection>
            )}
          </div>
        )}
      </div>
    </DesktopAppShell>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────

function PlanSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {title}
      </h2>
      {children}
    </section>
  );
}

function EmptyLine({ children }: { children?: React.ReactNode }) {
  return (
    <p className="text-sm text-zinc-400 dark:text-zinc-500">
      {children ?? "—"}
    </p>
  );
}
