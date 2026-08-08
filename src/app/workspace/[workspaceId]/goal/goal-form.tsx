"use client";
/**
 * GoalForm — Product goal input form
 *
 * Captures structured product intent: goal description, repos,
 * requirement documents, and technical constraints.
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "@/i18n";
import { desktopAwareFetch } from "@/client/utils/diagnostics";
import { resolveApiPath } from "@/client/config/backend";
import type {
  ProductGoal,
  ProductGoalRepo,
  ProductGoalRequirementDoc,
} from "@/core/models/product-goal";
import Link from "next/link";
import { Plus, Trash2, FileText, FolderGit2, Lock } from "lucide-react";

interface GoalFormProps {
  workspaceId: string;
  goalId?: string | null;
}

export function GoalForm({ workspaceId, goalId }: GoalFormProps) {
  const { t } = useTranslation();

  const [goalText, setGoalText] = useState("");
  const [repos, setRepos] = useState<ProductGoalRepo[]>([]);
  const [requirementDocs, setRequirementDocs] = useState<ProductGoalRequirementDoc[]>([]);
  const [constraints, setConstraints] = useState<string[]>([]);
  const [status, setStatus] = useState<"draft" | "active">("draft");
  const [currentGoalId, setCurrentGoalId] = useState<string | null>(goalId ?? null);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(!!goalId);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Load existing goal if goalId is provided
  useEffect(() => {
    if (!goalId) return;
    setFetching(true);
    desktopAwareFetch(resolveApiPath(`/api/goals/${goalId}`))
      .then((res) => {
        if (!res.ok) throw new Error(t.goal.loadError);
        return res.json();
      })
      .then((data: { goal: ProductGoal }) => {
        const g = data.goal;
        setGoalText(g.goalText);
        setRepos(g.repos ?? []);
        setRequirementDocs(g.requirementDocs ?? []);
        setConstraints(g.constraints ?? []);
        setStatus(g.status);
        setCurrentGoalId(g.id);
      })
      .catch((err) => {
        setMessage({ type: "error", text: err.message });
      })
      .finally(() => setFetching(false));
  }, [goalId, t]);

  const handleSave = useCallback(async () => {
    setLoading(true);
    setMessage(null);

    const payload = {
      workspaceId,
      goalText,
      repos,
      requirementDocs,
      constraints,
    };

    try {
      let res: Response;
      if (currentGoalId) {
        res = await desktopAwareFetch(resolveApiPath(`/api/goals/${currentGoalId}`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        res = await desktopAwareFetch(resolveApiPath("/api/goals"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }

      if (!res.ok) throw new Error(t.goal.saveError);
      const data = await res.json();
      setCurrentGoalId(data.goal.id);
      setMessage({ type: "success", text: t.goal.saveSuccess });
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof Error ? err.message : t.goal.saveError,
      });
    } finally {
      setLoading(false);
    }
  }, [workspaceId, goalText, repos, requirementDocs, constraints, currentGoalId, t]);

  // ─── Repo handlers ───────────────────────────────────────────────

  const addRepo = () => {
    setRepos([...repos, { kind: "local", path: "" }]);
  };

  const updateRepo = (index: number, field: keyof ProductGoalRepo, value: string) => {
    setRepos(repos.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  };

  const removeRepo = (index: number) => {
    setRepos(repos.filter((_, i) => i !== index));
  };

  // ─── Doc handlers ────────────────────────────────────────────────

  const addDoc = () => {
    setRequirementDocs([...requirementDocs, { name: "", content: "" }]);
  };

  const updateDoc = (index: number, field: keyof ProductGoalRequirementDoc, value: string) => {
    setRequirementDocs(requirementDocs.map((d, i) => (i === index ? { ...d, [field]: value } : d)));
  };

  const removeDoc = (index: number) => {
    setRequirementDocs(requirementDocs.filter((_, i) => i !== index));
  };

  // ─── Constraint handlers ─────────────────────────────────────────

  const addConstraint = () => {
    setConstraints([...constraints, ""]);
  };

  const updateConstraint = (index: number, value: string) => {
    setConstraints(constraints.map((c, i) => (i === index ? value : c)));
  };

  const removeConstraint = (index: number) => {
    setConstraints(constraints.filter((_, i) => i !== index));
  };

  if (fetching) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="text-muted-foreground">{t.common.loading}</span>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold">{t.goal.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.goal.description}</p>
      </div>

      {/* Status badge */}
      {currentGoalId && (
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
              status === "active"
                ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                : "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200"
            }`}
          >
            {status === "active" ? t.goal.active : t.goal.draft}
          </span>
        </div>
      )}

      {/* Goal Text */}
      <div className="space-y-2">
        <label htmlFor="goal-text" className="block text-sm font-medium">
          {t.goal.goalText}
        </label>
        <textarea
          id="goal-text"
          rows={6}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder={t.goal.goalTextPlaceholder}
          value={goalText}
          onChange={(e) => setGoalText(e.target.value)}
        />
      </div>

      {/* Repos */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderGit2 className="h-4 w-4" />
            <h2 className="text-sm font-medium">{t.goal.repos}</h2>
          </div>
          <button
            type="button"
            onClick={addRepo}
            className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 py-1 text-xs hover:bg-accent"
          >
            <Plus className="h-3 w-3" />
            {t.goal.addRepo}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">{t.goal.reposDescription}</p>
        {repos.map((repo, i) => (
          <div key={i} className="flex items-start gap-2 rounded-md border border-input p-3">
            <select
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={repo.kind}
              onChange={(e) => updateRepo(i, "kind", e.target.value)}
            >
              <option value="local">{t.goal.repoKindLocal}</option>
              <option value="github">{t.goal.repoKindGithub}</option>
            </select>
            {repo.kind === "local" ? (
              <input
                type="text"
                className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm placeholder:text-muted-foreground"
                placeholder={t.goal.repoPath}
                value={repo.path ?? ""}
                onChange={(e) => updateRepo(i, "path", e.target.value)}
              />
            ) : (
              <input
                type="text"
                className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm placeholder:text-muted-foreground"
                placeholder={t.goal.repoUrl}
                value={repo.url ?? ""}
                onChange={(e) => updateRepo(i, "url", e.target.value)}
              />
            )}
            <button
              type="button"
              onClick={() => removeRepo(i)}
              className="rounded-md p-1 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </section>

      {/* Requirement Docs */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            <h2 className="text-sm font-medium">{t.goal.requirementDocs}</h2>
          </div>
          <button
            type="button"
            onClick={addDoc}
            className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 py-1 text-xs hover:bg-accent"
          >
            <Plus className="h-3 w-3" />
            {t.goal.addDoc}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">{t.goal.requirementDocsDescription}</p>
        {requirementDocs.map((doc, i) => (
          <div key={i} className="space-y-2 rounded-md border border-input p-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm placeholder:text-muted-foreground"
                placeholder={t.goal.docNamePlaceholder}
                value={doc.name}
                onChange={(e) => updateDoc(i, "name", e.target.value)}
              />
              <button
                type="button"
                onClick={() => removeDoc(i)}
                className="rounded-md p-1 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <textarea
              rows={4}
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm placeholder:text-muted-foreground"
              placeholder={t.goal.docContentPlaceholder}
              value={doc.content}
              onChange={(e) => updateDoc(i, "content", e.target.value)}
            />
          </div>
        ))}
      </section>

      {/* Constraints */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4" />
            <h2 className="text-sm font-medium">{t.goal.constraints}</h2>
          </div>
          <button
            type="button"
            onClick={addConstraint}
            className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 py-1 text-xs hover:bg-accent"
          >
            <Plus className="h-3 w-3" />
            {t.goal.addConstraint}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">{t.goal.constraintsDescription}</p>
        {constraints.map((c, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="text"
              className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm placeholder:text-muted-foreground"
              placeholder={t.goal.constraintPlaceholder}
              value={c}
              onChange={(e) => updateConstraint(i, e.target.value)}
            />
            <button
              type="button"
              onClick={() => removeConstraint(i)}
              className="rounded-md p-1 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </section>

      {/* Feedback message */}
      {message && (
        <div
          className={`rounded-md px-3 py-2 text-sm ${
            message.type === "success"
              ? "bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300"
              : "bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={loading || !goalText.trim()}
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? t.common.loading : t.goal.save}
        </button>
        {currentGoalId && (
          <Link
            href={`/workspace/${workspaceId}/plan`}
            className="inline-flex items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            {t.goal.startPlanning}
          </Link>
        )}
      </div>
    </div>
  );
}
