/**
 * Provider-neutral recovery envelope ("bounded context rebuild").
 *
 * When a provider runtime must be REBUILT (no native resume possible, or the
 * native resume failed), the fresh provider conversation has no memory of the
 * interrupted work. This module builds ONE bounded envelope from DURABLE
 * Routa state and injects it exactly once:
 *
 * - Team objective (the first genuine user message of the Team Lead);
 * - Lead role + Team Chain policy prompt;
 * - task tree summary with unfinished tasks prioritized;
 * - member/child session status with their current task linkage;
 * - completed child completion reports and blocking task issues;
 * - a bounded slice of recent user/assistant history;
 * - workspace / cwd / branch facts.
 *
 * Injection channels (exactly one, exactly once):
 * - providers with a system-prompt append channel (Claude CLI
 *   `--append-system-prompt`, Claude Code SDK `systemPromptAppend`) receive
 *   the envelope at runtime creation;
 * - providers without such a channel receive it as a clearly-marked one-shot
 *   prefix on the next dispatched prompt (`setPendingRecoveryContext` →
 *   `consumePendingRecoveryContext` in session-prompt).
 *
 * The envelope is NEVER injected when native resume succeeds — the provider
 * conversation already holds its own context. There is no full chunk replay
 * and no forged second user message: the rendered block is explicitly marked
 * as internal recovery context, and for the prefix channel it is never
 * recorded in the durable history.
 */

import type { SessionUpdateNotification } from "@/core/acp/http-session-store";
import {
  isTeamReportDeliveryId,
  parseTeamReportDeliveryId,
} from "@/core/orchestration/team-report-delivery";

// ─── Schema & limits ───────────────────────────────────────────────────────

export const RECOVERY_ENVELOPE_SCHEMA = "routa.recovery-envelope@1";

/** Hard caps that keep the envelope bounded regardless of team/history size. */
export interface RecoveryEnvelopeLimits {
  maxTasks: number;
  maxMembers: number;
  maxReports: number;
  maxHistoryEntries: number;
  /** Per-entry text cap (objective, task objective, report summary, history). */
  maxTextChars: number;
  /** Team objective cap. */
  maxObjectiveChars: number;
}

export const DEFAULT_RECOVERY_ENVELOPE_LIMITS: RecoveryEnvelopeLimits = {
  maxTasks: 40,
  maxMembers: 24,
  maxReports: 8,
  maxHistoryEntries: 12,
  maxTextChars: 400,
  maxObjectiveChars: 800,
};

/** Cap for the Lead role + Team Chain policy prompt section. */
const MAX_LEAD_POLICY_CHARS = 8_000;

const UNFINISHED_TASK_STATUSES = new Set([
  "PENDING",
  "IN_PROGRESS",
  "REVIEW_REQUIRED",
  "NEEDS_FIX",
  "BLOCKED",
]);

const BLOCKING_TASK_STATUSES = new Set(["BLOCKED", "NEEDS_FIX"]);

/** True for task statuses that still need work (bounded-selection priority). */
export function isUnfinishedTaskStatus(status: string | undefined): boolean {
  return UNFINISHED_TASK_STATUSES.has(String(status ?? "").toUpperCase());
}

// ─── Model ─────────────────────────────────────────────────────────────────

export interface RecoverySessionFacts {
  sessionId: string;
  provider?: string;
  role?: string;
  cwd?: string;
  branch?: string;
  workspaceId?: string;
}

export interface RecoveryTaskFact {
  id: string;
  title: string;
  status: string;
  objective?: string;
  assignedTo?: string;
}

export interface RecoveryMemberFact {
  agentId: string;
  sessionId?: string;
  role?: string;
  taskId?: string;
  taskTitle?: string;
  taskStatus?: string;
}

export interface RecoveryReportFact {
  deliveryId: string;
  childSessionId?: string;
  taskId?: string;
  text: string;
}

export interface RecoveryTeamFacts {
  teamRunId?: string;
  objective?: string;
  /** Rebuilt Lead role + Team Chain policy prompt. */
  leadPolicyPrompt?: string;
  tasks: RecoveryTaskFact[];
  members: RecoveryMemberFact[];
  reports: RecoveryReportFact[];
}

export interface RecoveryHistoryFact {
  role: "user" | "assistant";
  text: string;
}

export interface RecoveryEnvelopeInput {
  session: RecoverySessionFacts;
  team?: RecoveryTeamFacts;
  history?: RecoveryHistoryFact[];
  limits?: Partial<RecoveryEnvelopeLimits>;
}

export interface RecoveryBlockingIssue {
  taskId: string;
  title: string;
  status: string;
}

export interface RecoveryEnvelopeReport {
  deliveryId: string;
  childSessionId?: string;
  taskId?: string;
  summary: string;
}

export interface RecoveryEnvelopeTeam {
  teamRunId?: string;
  objective?: string;
  leadPolicyPrompt?: string;
  tasks: RecoveryTaskFact[];
  totalTasks: number;
  unfinishedTaskCount: number;
  droppedTaskCount: number;
  members: RecoveryMemberFact[];
  totalMembers: number;
  droppedMemberCount: number;
  reports: RecoveryEnvelopeReport[];
  totalReports: number;
  blockingIssues: RecoveryBlockingIssue[];
}

export interface RecoveryEnvelopeHistoryEntry {
  role: "user" | "assistant";
  text: string;
}

export interface RecoveryEnvelope {
  schema: typeof RECOVERY_ENVELOPE_SCHEMA;
  session: RecoverySessionFacts;
  team?: RecoveryEnvelopeTeam;
  recentHistory: RecoveryEnvelopeHistoryEntry[];
  droppedHistoryCount: number;
}

// ─── Bounded selection (pure) ──────────────────────────────────────────────

function trimText(text: string | undefined, maxChars: number): string | undefined {
  if (typeof text !== "string") return undefined;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/**
 * Build the bounded recovery envelope. Pure and deterministic: unfinished
 * tasks first, most recent reports/history kept, every list and text capped.
 */
export function buildRecoveryEnvelope(input: RecoveryEnvelopeInput): RecoveryEnvelope {
  const limits: RecoveryEnvelopeLimits = {
    ...DEFAULT_RECOVERY_ENVELOPE_LIMITS,
    ...input.limits,
  };

  let team: RecoveryEnvelopeTeam | undefined;
  if (input.team) {
    const allTasks = input.team.tasks;
    const unfinished = allTasks.filter((task) => isUnfinishedTaskStatus(task.status));
    const terminal = allTasks.filter((task) => !isUnfinishedTaskStatus(task.status));
    const orderedTasks = [...unfinished, ...terminal];
    const keptTasks = orderedTasks.slice(0, limits.maxTasks).map((task) => ({
      id: task.id,
      title: trimText(task.title, limits.maxTextChars) ?? task.id,
      status: String(task.status ?? "UNKNOWN"),
      objective: trimText(task.objective, limits.maxTextChars),
      assignedTo: task.assignedTo,
    }));

    const keptMembers = input.team.members.slice(0, limits.maxMembers);
    const keptReports = input.team.reports.slice(-limits.maxReports).map((report) => ({
      deliveryId: report.deliveryId,
      childSessionId: report.childSessionId,
      taskId: report.taskId,
      summary: trimText(report.text, limits.maxTextChars) ?? "",
    }));

    team = {
      teamRunId: input.team.teamRunId,
      objective: trimText(input.team.objective, limits.maxObjectiveChars),
      leadPolicyPrompt: trimText(input.team.leadPolicyPrompt, MAX_LEAD_POLICY_CHARS),
      tasks: keptTasks,
      totalTasks: allTasks.length,
      unfinishedTaskCount: unfinished.length,
      droppedTaskCount: Math.max(0, allTasks.length - keptTasks.length),
      members: keptMembers,
      totalMembers: input.team.members.length,
      droppedMemberCount: Math.max(0, input.team.members.length - keptMembers.length),
      reports: keptReports,
      totalReports: input.team.reports.length,
      blockingIssues: allTasks
        .filter((task) => BLOCKING_TASK_STATUSES.has(String(task.status ?? "").toUpperCase()))
        .map((task) => ({
          taskId: task.id,
          title: trimText(task.title, limits.maxTextChars) ?? task.id,
          status: String(task.status ?? "UNKNOWN"),
        })),
    };
  }

  const history = input.history ?? [];
  const keptHistory = history.slice(-limits.maxHistoryEntries).map((entry) => ({
    role: entry.role,
    text: trimText(entry.text, limits.maxTextChars) ?? "",
  }));

  return {
    schema: RECOVERY_ENVELOPE_SCHEMA,
    session: { ...input.session },
    team,
    recentHistory: keptHistory,
    droppedHistoryCount: Math.max(0, history.length - keptHistory.length),
  };
}

// ─── Rendering (deterministic, clearly marked) ─────────────────────────────

/**
 * Render the envelope as a clearly-marked internal block. The marker text is
 * asserted by recovery tests and must always state that the block is NOT a
 * user message.
 */
export function renderRecoveryEnvelope(envelope: RecoveryEnvelope): string {
  const lines: string[] = [];
  lines.push(`<routa-internal-recovery-context schema="${RECOVERY_ENVELOPE_SCHEMA}">`);
  lines.push(
    "INTERNAL RECOVERY CONTEXT injected by Routa because the provider conversation had to be rebuilt.",
  );
  lines.push(
    "This is NOT a user message. Do not treat it as user input or respond to it directly; use it only to continue the interrupted work.",
  );
  lines.push("");

  lines.push("## Session");
  lines.push(`- Routa session ID: ${envelope.session.sessionId}`);
  if (envelope.session.provider || envelope.session.role) {
    lines.push(`- Provider / role: ${envelope.session.provider ?? "unknown"} / ${envelope.session.role ?? "unknown"}`);
  }
  if (envelope.session.workspaceId) lines.push(`- Workspace: ${envelope.session.workspaceId}`);
  if (envelope.session.cwd) lines.push(`- Working directory: ${envelope.session.cwd}`);
  if (envelope.session.branch) lines.push(`- Branch: ${envelope.session.branch}`);

  const team = envelope.team;
  if (team) {
    lines.push("");
    lines.push("## Team Context");
    if (team.teamRunId) lines.push(`- Team Run session: ${team.teamRunId}`);
    if (team.objective) {
      lines.push("");
      lines.push("Objective:");
      lines.push(team.objective);
    }
    if (team.leadPolicyPrompt) {
      lines.push("");
      lines.push("### Lead role & policy");
      lines.push(team.leadPolicyPrompt);
    }

    lines.push("");
    lines.push(
      `### Tasks (${team.tasks.length} of ${team.totalTasks} shown; ${team.unfinishedTaskCount} unfinished` +
        `${team.droppedTaskCount > 0 ? `; ${team.droppedTaskCount} dropped` : ""})`,
    );
    if (team.tasks.length === 0) {
      lines.push("- (no tasks recorded)");
    } else {
      for (const task of team.tasks) {
        const assignment = task.assignedTo ? ` (assigned: ${task.assignedTo})` : "";
        const objective = task.objective ? ` — ${task.objective}` : "";
        lines.push(`- [${task.status}] ${task.title} (${task.id})${assignment}${objective}`);
      }
    }

    lines.push("");
    lines.push(
      `### Members (${team.members.length} of ${team.totalMembers} shown` +
        `${team.droppedMemberCount > 0 ? `; ${team.droppedMemberCount} dropped` : ""})`,
    );
    if (team.members.length === 0) {
      lines.push("- (no member sessions recorded)");
    } else {
      for (const member of team.members) {
        const task = member.taskId
          ? ` — task "${member.taskTitle ?? member.taskId}" [${member.taskStatus ?? "UNKNOWN"}] (${member.taskId})`
          : "";
        const session = member.sessionId ? ` session ${member.sessionId}` : "";
        lines.push(`- ${member.agentId}${member.role ? ` (${member.role})` : ""}${session}${task}`);
      }
    }

    if (team.reports.length > 0) {
      lines.push("");
      lines.push(`### Completed child reports (${team.reports.length} of ${team.totalReports} shown)`);
      for (const report of team.reports) {
        lines.push(`- [${report.deliveryId}]${report.summary ? ` ${report.summary}` : ""}`);
      }
    }

    if (team.blockingIssues.length > 0) {
      lines.push("");
      lines.push("### Blocking issues");
      for (const issue of team.blockingIssues) {
        lines.push(`- [${issue.status}] ${issue.title} (${issue.taskId})`);
      }
    }
  }

  if (envelope.recentHistory.length > 0) {
    lines.push("");
    lines.push(
      `## Recent activity (last ${envelope.recentHistory.length} entries` +
        `${envelope.droppedHistoryCount > 0 ? `; ${envelope.droppedHistoryCount} older entries omitted` : ""})`,
    );
    for (const entry of envelope.recentHistory) {
      lines.push(`- ${entry.role}: ${entry.text}`);
    }
  }

  lines.push("</routa-internal-recovery-context>");
  return lines.join("\n");
}

// ─── One-shot prefix channel for providers without a system append channel ──

const pendingRecoveryContexts = new Map<string, string>();
const MAX_PENDING_RECOVERY_CONTEXTS = 256;

/**
 * Queue the rendered recovery envelope for one-shot prefix injection on the
 * next dispatched prompt (providers without a system-prompt append channel).
 * Overwrites any previously queued context for the same session.
 */
export function setPendingRecoveryContext(sessionId: string, text: string): void {
  if (!text.trim()) return;
  if (!pendingRecoveryContexts.has(sessionId)
    && pendingRecoveryContexts.size >= MAX_PENDING_RECOVERY_CONTEXTS) {
    const oldest = pendingRecoveryContexts.keys().next().value;
    if (oldest !== undefined) pendingRecoveryContexts.delete(oldest);
  }
  pendingRecoveryContexts.set(sessionId, text);
}

/**
 * Consume the queued recovery context for a session. Returns it exactly once;
 * subsequent calls return undefined until a new context is queued.
 */
export function consumePendingRecoveryContext(sessionId: string): string | undefined {
  const pending = pendingRecoveryContexts.get(sessionId);
  if (pending !== undefined) pendingRecoveryContexts.delete(sessionId);
  return pending;
}

/** Test hook: drop all queued recovery contexts. */
export function clearPendingRecoveryContextsForTest(): void {
  pendingRecoveryContexts.clear();
}

// ─── Durable collection (async) ────────────────────────────────────────────

export interface RecoveryContextRequest {
  sessionId: string;
  provider?: string;
  role?: string;
  cwd?: string;
  branch?: string;
  workspaceId?: string;
  specialistId?: string;
  /** Rebuilt Lead role + Team Chain policy prompt (already bounded). */
  specialistSystemPrompt?: string;
  limits?: Partial<RecoveryEnvelopeLimits>;
}

/** Minimal durable session shape needed for team collection. */
interface RecoverySessionShape {
  sessionId: string;
  name?: string;
  role?: string;
  specialistId?: string;
  parentSessionId?: string;
  routaAgentId?: string;
  workspaceId?: string;
  cwd?: string;
}

/** Minimal durable task shape needed for team collection. */
interface RecoveryTaskShape {
  id: string;
  title: string;
  status: string;
  objective?: string;
  assignedTo?: string;
  teamRunId?: string;
  sessionId?: string;
  workspaceId?: string;
  updatedAt?: Date | string | number;
}

/** Minimal Routa system surface needed for team collection. */
interface RecoverySystemShape {
  taskStore: {
    listByWorkspace: (workspaceId: string) => Promise<RecoveryTaskShape[]>;
    listByAssignee: (agentId: string) => Promise<RecoveryTaskShape[]>;
  };
}

interface RecoveryHistorySource {
  getConsolidatedHistory?: (sessionId: string) => SessionUpdateNotification[];
  getHistory?: (sessionId: string) => SessionUpdateNotification[];
  listSessions?: () => RecoverySessionShape[];
  hydrateFromDb?: () => Promise<void> | void;
}

interface ExtractedHistory {
  facts: RecoveryHistoryFact[];
  reports: RecoveryReportFact[];
}

function extractContentText(content: unknown): string | undefined {
  if (!content || typeof content !== "object") return undefined;
  const text = (content as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

/**
 * Extract user/assistant history facts and Team report deliveries from raw
 * history entries. Team report deliveries surface as `reports` (never as user
 * history); delivery receipts are ignored. Consecutive assistant chunks are
 * merged into single entries.
 */
function extractHistory(entries: SessionUpdateNotification[]): ExtractedHistory {
  const facts: RecoveryHistoryFact[] = [];
  const reports: RecoveryReportFact[] = [];
  let pendingAssistant: string[] = [];

  const flushAssistant = () => {
    if (pendingAssistant.length > 0) {
      facts.push({ role: "assistant", text: pendingAssistant.join("") });
      pendingAssistant = [];
    }
  };

  for (const entry of entries) {
    const update = (entry as { update?: Record<string, unknown> }).update;
    const kind = update?.sessionUpdate;
    const text = extractContentText(update?.content);

    if (kind === "user_message") {
      flushAssistant();
      const eventId = typeof entry.eventId === "string" ? entry.eventId : undefined;
      if (eventId && isTeamReportDeliveryId(eventId)) {
        const parsed = parseTeamReportDeliveryId(eventId);
        reports.push({
          deliveryId: eventId,
          childSessionId: parsed?.childSessionId,
          taskId: parsed?.taskId,
          text: text ?? "",
        });
      } else if (text) {
        facts.push({ role: "user", text });
      }
    } else if (kind === "agent_message" || kind === "agent_message_chunk") {
      if (text) pendingAssistant.push(text);
    } else {
      flushAssistant();
    }
  }
  flushAssistant();

  return { facts, reports };
}

async function loadMergedHistory(
  store: RecoveryHistorySource,
  sessionId: string,
  cwd?: string,
): Promise<SessionUpdateNotification[]> {
  let dbHistory: SessionUpdateNotification[] = [];
  try {
    const { loadHistoryFromDb } = await import("@/core/acp/session-db-persister");
    dbHistory = (await loadHistoryFromDb(sessionId, cwd)) ?? [];
  } catch (err) {
    console.warn(`[RecoveryContext] Failed to load durable history for ${sessionId}:`, err);
  }

  const memoryHistory = store.getConsolidatedHistory?.(sessionId)
    ?? store.getHistory?.(sessionId)
    ?? [];

  if (dbHistory.length === 0) return memoryHistory;
  if (memoryHistory.length === 0) return dbHistory;

  // Merge: durable order first, then in-memory entries not present in the DB
  // snapshot (by eventId). Dedup keeps the envelope bounded.
  const seen = new Set<string>();
  for (const entry of dbHistory) {
    if (typeof entry.eventId === "string") seen.add(entry.eventId);
  }
  const merged = [...dbHistory];
  for (const entry of memoryHistory) {
    if (typeof entry.eventId === "string" && seen.has(entry.eventId)) continue;
    merged.push(entry);
  }
  return merged;
}

function updatedAtMs(task: RecoveryTaskShape): number {
  const value = task.updatedAt;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Collect the Team facts for a session that belongs to a Team Run. Returns
 * undefined for sessions that are not part of a resolvable Team Run. All
 * heavy ports are imported dynamically to keep this module free of static
 * orchestration cycles.
 */
async function collectTeamFacts(
  request: RecoveryContextRequest,
  store: RecoveryHistorySource,
  ownHistory: SessionUpdateNotification[],
): Promise<RecoveryTeamFacts | undefined> {
  const { resolveOwningTeamRunId } = await import("@/core/orchestration/team-run-ownership");
  const { collectTeamSessionIds } = await import("@/core/orchestration/team-run-identity");

  try {
    await store.hydrateFromDb?.();
  } catch (err) {
    console.warn(`[RecoveryContext] Session hydration failed for ${request.sessionId}:`, err);
  }
  const sessions = store.listSessions?.() ?? [];
  // Ownership resolution requires a workspace-scoped session list; sessions
  // without a workspace can never be part of (or own) a Team Run.
  const ownershipSessions = sessions.filter(
    (session): session is RecoverySessionShape & { workspaceId: string } =>
      typeof session.workspaceId === "string",
  );
  const teamRunId = resolveOwningTeamRunId(request.sessionId, ownershipSessions);
  if (!teamRunId) return undefined;

  const teamSessionIds = new Set(collectTeamSessionIds(teamRunId, sessions));
  const rootSession = sessions.find((session) => session.sessionId === teamRunId);

  let system: RecoverySystemShape | undefined;
  try {
    const { getRoutaSystem } = await import("@/core/routa-system");
    system = getRoutaSystem() as unknown as RecoverySystemShape;
  } catch (err) {
    console.warn("[RecoveryContext] Routa system unavailable for team collection:", err);
  }

  // Members: every descendant session with its current task linkage.
  const members: RecoveryMemberFact[] = [];
  if (system) {
    for (const session of sessions) {
      if (!teamSessionIds.has(session.sessionId)) continue;
      if (session.sessionId === teamRunId) continue;

      let task: RecoveryTaskShape | undefined;
      if (session.routaAgentId) {
        try {
          const assigned = (await system.taskStore.listByAssignee(session.routaAgentId)) as RecoveryTaskShape[];
          task = assigned
            .filter((candidate) => candidate.teamRunId === teamRunId
              || candidate.workspaceId === session.workspaceId)
            .sort((a, b) => updatedAtMs(b) - updatedAtMs(a))[0];
        } catch (err) {
          console.warn(
            `[RecoveryContext] Could not resolve tasks for member agent ${session.routaAgentId}:`,
            err,
          );
        }
      }

      members.push({
        agentId: session.routaAgentId ?? session.sessionId,
        sessionId: session.sessionId,
        role: session.role,
        taskId: task?.id,
        taskTitle: task?.title,
        taskStatus: task ? String(task.status) : undefined,
      });
    }
  }

  // Tasks: the Team Run's durable cards (teamRunId match, or assigned to /
  // created by a team session), unfinished-first at render time.
  const teamTasks: RecoveryTaskFact[] = [];
  const workspaceId = request.workspaceId ?? rootSession?.workspaceId;
  if (system && workspaceId) {
    try {
      const memberAgentIds = new Set(members.map((member) => member.agentId));
      const all = (await system.taskStore.listByWorkspace(workspaceId)) as RecoveryTaskShape[];
      // A task carrying an explicit teamRunId is authoritative: tasks of a
      // foreign team run are excluded even if assigned to a team member.
      const matched = all.filter((task) => {
        if (task.teamRunId !== undefined && task.teamRunId !== null && task.teamRunId !== "") {
          return task.teamRunId === teamRunId;
        }
        return (task.assignedTo !== undefined && memberAgentIds.has(task.assignedTo))
          || (task.sessionId !== undefined && teamSessionIds.has(task.sessionId));
      });
      matched.sort((a, b) => updatedAtMs(b) - updatedAtMs(a));
      for (const task of matched) {
        teamTasks.push({
          id: task.id,
          title: task.title,
          status: String(task.status),
          objective: task.objective,
          assignedTo: task.assignedTo,
        });
      }
    } catch (err) {
      console.warn(`[RecoveryContext] Could not list workspace tasks for ${workspaceId}:`, err);
    }
  }

  // Objective + reports come from the Team Lead (root) history. Team report
  // deliveries never count as the objective.
  let leadHistory = ownHistory;
  if (teamRunId !== request.sessionId) {
    leadHistory = await loadMergedHistory(store, teamRunId, rootSession?.cwd ?? request.cwd);
  }
  const leadExtracted = extractHistory(leadHistory);
  const objective = leadExtracted.facts.find((fact) => fact.role === "user")?.text;

  const reports = [...leadExtracted.reports];
  if (teamRunId !== request.sessionId) {
    // Mid-level parents receive their own reports; merge without duplicates.
    for (const report of extractHistory(ownHistory).reports) {
      if (!reports.some((existing) => existing.deliveryId === report.deliveryId)) {
        reports.push(report);
      }
    }
  }

  return {
    teamRunId,
    objective,
    leadPolicyPrompt: request.specialistSystemPrompt,
    tasks: teamTasks,
    members,
    reports,
  };
}

/**
 * Collect and build the bounded recovery envelope for a session being
 * rebuilt. Best-effort: any failure degrades to `undefined` (recovery
 * proceeds without an envelope) and never throws.
 */
export async function collectRecoveryEnvelope(
  request: RecoveryContextRequest,
): Promise<RecoveryEnvelope | undefined> {
  try {
    const { getHttpSessionStore } = await import("@/core/acp/http-session-store");
    const store = getHttpSessionStore() as unknown as RecoveryHistorySource;

    const ownHistory = await loadMergedHistory(store, request.sessionId, request.cwd);
    const { facts } = extractHistory(ownHistory);
    const team = await collectTeamFacts(request, store, ownHistory);

    return buildRecoveryEnvelope({
      session: {
        sessionId: request.sessionId,
        provider: request.provider,
        role: request.role,
        cwd: request.cwd,
        branch: request.branch,
        workspaceId: request.workspaceId,
      },
      team,
      history: facts,
      limits: request.limits,
    });
  } catch (err) {
    console.warn(`[RecoveryContext] Failed to collect recovery envelope for ${request.sessionId}:`, err);
    return undefined;
  }
}
