/**
 * Delivery Report Aggregator
 *
 * Builds a unified, READ-ONLY delivery overview from existing stores.
 * Aggregates tasks, artifacts, verification data, and trace run outcomes
 * into a single report for the Final Delivery View.
 *
 * Every section degrades gracefully: missing data → empty arrays, never throws.
 */

import type { Task } from "../models/task";
import { TaskStatus } from "../models/task";
import type { Artifact } from "../models/artifact";
import type { ArtifactStore } from "../store/artifact-store";
import type { TaskStore } from "../store/task-store";
import type { CodebaseStore } from "../db/pg-codebase-store";
import type { RunOutcome } from "../trace/run-outcome";
import { readRunOutcomes } from "../trace/run-outcome";

// ---------------------------------------------------------------------------
// Report Types
// ---------------------------------------------------------------------------

export interface DeliveryProgress {
  total: number;
  done: number;
  inProgress: number;
  review: number;
  blocked: number;
}

export interface DeliveryEvidence {
  type: string;
  summary: string;
}

export interface DeliveryCompletedTask {
  taskId: string;
  title: string;
  verificationVerdict?: string;
  evidence: DeliveryEvidence[];
}

export interface DeliveryOutstandingTask {
  taskId: string;
  title: string;
  status: string;
  blocker?: string;
}

export interface DeliveryRisk {
  taskId?: string;
  description: string;
}

export interface DeliveryHowToRun {
  command: string;
  description?: string;
}

export interface DeliveryRecentRun {
  id: string;
  summary: string;
}

export interface DeliveryAudit {
  traceCount: number;
  tracePagePath: string;
  recentRuns: DeliveryRecentRun[];
}

export interface DeliveryReport {
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
// Aggregator
// ---------------------------------------------------------------------------

export interface BuildDeliveryReportParams {
  workspaceId: string;
  taskStore: TaskStore;
  artifactStore: ArtifactStore;
  codebaseStore: CodebaseStore;
}

/**
 * Build a full DeliveryReport for a workspace.
 * Pure aggregation over existing stores — no mutations.
 */
export async function buildDeliveryReport(
  params: BuildDeliveryReportParams,
): Promise<DeliveryReport> {
  const { workspaceId, taskStore, artifactStore, codebaseStore } = params;

  let tasks: Task[];
  try {
    tasks = await taskStore.listByWorkspace(workspaceId);
  } catch {
    tasks = [];
  }

  const progress = buildProgress(tasks);
  const completed = await buildCompleted(tasks, artifactStore);
  const outstanding = buildOutstanding(tasks);
  const risks = buildRisks(tasks);
  const howToRun = buildHowToRun(tasks);
  const audit = await buildAudit(workspaceId, codebaseStore);

  return {
    workspaceId,
    generatedAt: new Date().toISOString(),
    progress,
    completed,
    outstanding,
    risks,
    howToRun,
    audit,
  };
}

// ---------------------------------------------------------------------------
// Section Builders
// ---------------------------------------------------------------------------

function buildProgress(tasks: Task[]): DeliveryProgress {
  const progress: DeliveryProgress = {
    total: tasks.length,
    done: 0,
    inProgress: 0,
    review: 0,
    blocked: 0,
  };

  for (const task of tasks) {
    switch (task.status) {
      case TaskStatus.COMPLETED:
        progress.done += 1;
        break;
      case TaskStatus.IN_PROGRESS:
        progress.inProgress += 1;
        break;
      case TaskStatus.REVIEW_REQUIRED:
        progress.review += 1;
        break;
      case TaskStatus.BLOCKED:
        progress.blocked += 1;
        break;
      default:
        // PENDING, NEEDS_FIX, CANCELLED — counted in total but not in sub-buckets
        break;
    }
  }

  return progress;
}

async function buildCompleted(
  tasks: Task[],
  artifactStore: ArtifactStore,
): Promise<DeliveryCompletedTask[]> {
  const completedTasks = tasks.filter((t) => t.status === TaskStatus.COMPLETED);
  const results: DeliveryCompletedTask[] = [];

  for (const task of completedTasks) {
    const evidence = await buildTaskEvidence(task, artifactStore);
    results.push({
      taskId: task.id,
      title: task.title,
      verificationVerdict: task.verificationVerdict ?? undefined,
      evidence,
    });
  }

  return results;
}

async function buildTaskEvidence(
  task: Task,
  artifactStore: ArtifactStore,
): Promise<DeliveryEvidence[]> {
  const evidence: DeliveryEvidence[] = [];

  // Verification verdict
  if (task.verificationVerdict) {
    evidence.push({
      type: "verification",
      summary: `Verdict: ${task.verificationVerdict}`,
    });
  }

  // Verification report
  if (task.verificationReport) {
    const snippet = task.verificationReport.length > 200
      ? task.verificationReport.slice(0, 200) + "…"
      : task.verificationReport;
    evidence.push({
      type: "verification_report",
      summary: snippet,
    });
  }

  // Completion summary
  if (task.completionSummary) {
    evidence.push({
      type: "completion_summary",
      summary: task.completionSummary,
    });
  }

  // Delivery snapshot
  if (task.deliverySnapshot) {
    const snap = task.deliverySnapshot;
    const commitCount = snap.commits?.length ?? 0;
    evidence.push({
      type: "delivery_snapshot",
      summary: `${commitCount} commit(s) on ${snap.branch ?? "branch"} (${snap.headSha?.slice(0, 7) ?? "unknown"})`,
    });
  }

  // Artifacts from store
  let artifacts: Artifact[] = [];
  try {
    artifacts = await artifactStore.listByTask(task.id);
  } catch {
    // Ignore store failures
  }

  for (const artifact of artifacts) {
    if (artifact.status !== "provided") continue;
    const summary = artifact.context
      || `${artifact.type} artifact`
      || artifact.type;
    evidence.push({
      type: `artifact:${artifact.type}`,
      summary,
    });
  }

  return evidence;
}

function buildOutstanding(tasks: Task[]): DeliveryOutstandingTask[] {
  const outstandingStatuses = new Set<TaskStatus>([
    TaskStatus.PENDING,
    TaskStatus.IN_PROGRESS,
    TaskStatus.REVIEW_REQUIRED,
    TaskStatus.BLOCKED,
    TaskStatus.NEEDS_FIX,
  ]);

  return tasks
    .filter((t) => outstandingStatuses.has(t.status))
    .map((task) => {
      const blocker = deriveBlocker(task);
      return {
        taskId: task.id,
        title: task.title,
        status: task.status,
        blocker,
      };
    });
}

function deriveBlocker(task: Task): string | undefined {
  if (task.status === TaskStatus.BLOCKED) {
    // Try comment, completionSummary, or last lane session recovery reason
    if (task.comment) return task.comment;
    if (task.completionSummary) return task.completionSummary;
    const lastSession = task.laneSessions?.[task.laneSessions.length - 1];
    if (lastSession?.recoveryReason) return lastSession.recoveryReason;
    return "Blocked (no reason recorded)";
  }
  if (task.status === TaskStatus.NEEDS_FIX) {
    if (task.verificationReport) return task.verificationReport.slice(0, 200);
    return "Needs fix";
  }
  return undefined;
}

function buildRisks(tasks: Task[]): DeliveryRisk[] {
  const risks: DeliveryRisk[] = [];

  for (const task of tasks) {
    // Blocked tasks are risks
    if (task.status === TaskStatus.BLOCKED) {
      risks.push({
        taskId: task.id,
        description: `Task "${task.title}" is blocked${task.comment ? `: ${task.comment}` : ""}`,
      });
    }

    // Tasks with unmet story readiness
    if (task.jitContextSnapshot?.warnings) {
      for (const warning of task.jitContextSnapshot.warnings) {
        risks.push({
          taskId: task.id,
          description: warning,
        });
      }
    }

    // Failed lane sessions
    const failedSessions = (task.laneSessions ?? []).filter(
      (s) => s.status === "failed" || s.status === "timed_out",
    );
    if (failedSessions.length > 0) {
      risks.push({
        taskId: task.id,
        description: `${failedSessions.length} failed/timed-out session(s) on task "${task.title}"`,
      });
    }
  }

  return risks;
}

function buildHowToRun(tasks: Task[]): DeliveryHowToRun[] {
  const commands: DeliveryHowToRun[] = [];
  const seen = new Set<string>();

  for (const task of tasks) {
    if (!task.verificationCommands) continue;
    for (const cmd of task.verificationCommands) {
      const trimmed = cmd.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      commands.push({
        command: trimmed,
        description: task.title,
      });
    }
  }

  return commands;
}

async function buildAudit(
  workspaceId: string,
  codebaseStore: CodebaseStore,
): Promise<DeliveryAudit> {
  const audit: DeliveryAudit = {
    traceCount: 0,
    tracePagePath: "/traces",
    recentRuns: [],
  };

  // Try to load RunOutcome records from associated codebase repos
  let codebases: { repoPath: string }[] = [];
  try {
    codebases = await codebaseStore.listByWorkspace(workspaceId);
  } catch {
    // Ignore
  }

  const allOutcomes: RunOutcome[] = [];
  const seenIds = new Set<string>();

  for (const codebase of codebases) {
    let outcomes: RunOutcome[] = [];
    try {
      outcomes = await readRunOutcomes(codebase.repoPath);
    } catch {
      // Skip repos that can't be read
    }
    for (const outcome of outcomes) {
      if (outcome.workspaceId !== workspaceId) continue;
      if (seenIds.has(outcome.id)) continue;
      seenIds.add(outcome.id);
      allOutcomes.push(outcome);
    }
  }

  audit.traceCount = allOutcomes.length;

  // Sort by timestamp descending, take top 10
  allOutcomes.sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
    const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
    return tb - ta;
  });

  audit.recentRuns = allOutcomes.slice(0, 10).map((outcome) => ({
    id: outcome.id,
    summary: `${outcome.taskTitle} — ${outcome.outcome}${outcome.failureMode ? ` (${outcome.failureMode})` : ""}`,
  }));

  return audit;
}
