import { v4 as uuidv4 } from "uuid";
import * as fs from "fs";
import * as path from "path";
import { AgentRole, AgentStatus, type Agent } from "../models/agent";
import { TaskStatus, type Task } from "../models/task";
import { AgentEventType } from "../events/event-bus";
import { ToolResult, successResult, errorResult } from "../tools/tool-result";
import {
  getSpecialistByRole,
  getSpecialistById,
  buildDelegationPrompt,
  type SpecialistConfig,
} from "./specialist-prompts";
import type { RoutaSystem } from "../routa-system";
import type { AcpProcessManager } from "../acp/acp-process-manager";
import {
  checkDelegationDepth,
  calculateChildDepth,
  buildAgentMetadata,
} from "./delegation-depth";
import { AgentEventBridge, makeStartedEvent } from "../acp/agent-event-bridge";
import type { WorkspaceAgentEvent } from "../acp/agent-event-bridge";
import { getHttpSessionStore } from "../acp/http-session-store";
import { AgentMemoryWriter, type CompletionSnapshotSource } from "../storage/agent-memory-writer";
import { TraceReader } from "../trace/reader";
import { buildTraceRunDigest, formatDigestForRole } from "../trace/trace-run-digest";
import { buildRunOutcome, buildTaskFingerprint, saveRunOutcome } from "../trace/run-outcome";
import { formatPlaybookForRole, loadLearnedPlaybook, syncLearnedPlaybookArtifact } from "../trace/trace-playbook";
import {
  completionSnapshotsEqual,
  mergeCompletionSnapshot,
  normalizeNullableText,
  normalizeOptionalText,
  type ChildCompletionMemorySnapshot,
} from "./completion-memory";
import { appendSessionNotificationEventOnce } from "../acp/session-db-persister";
import {
  buildPromptDeliveryReceiptNotification,
  finalizePromptDelivery,
} from "../acp/prompt-delivery";
import { deriveNextTeamReportDeliveryId } from "./team-report-delivery";
import { releaseCompletedChildRuntime } from "./completed-child-release";
import { resolveOwningTeamRunIdFromSessions } from "./team-run-ownership";
import { applyTaskStatusTransition, loadTaskBoardColumns } from "../kanban/task-status-transition";
import {
  createDelegatedChildSession,
  dispatchDelegatedChildPrompt,
} from "./child-session-lifecycle";
import type {
  ChildAgentRecord,
  TeamRuntimeStateRestore,
  TeamSessionRegistration,
} from "./team-runtime-state";
export type { ChildAgentRecord } from "./team-runtime-state";

export interface DelegateWithSpawnParams {
  /** Task ID to delegate */
  taskId: string;
  /** Calling agent's ID */
  callerAgentId: string;
  /** Calling agent's session ID (for wake-up) */
  callerSessionId: string;
  /** Workspace ID */
  workspaceId: string;
  /** Specialist role: "CRAFTER", "GATE", "DEVELOPER" (or specialist ID like "crafter", "gate", "developer") */
  specialist: string;
  /** ACP provider to use for the child (e.g., "claude", "copilot", "opencode") */
  provider?: string;
  /** Working directory for the child agent */
  cwd?: string;
  /** Additional instructions beyond the task content */
  additionalInstructions?: string;
  /** Wait mode: "immediate" or "after_all" */
  waitMode?: "immediate" | "after_all";
}

export interface OrchestratorConfig {
  /** Default ACP provider for CRAFTER agents */
  defaultCrafterProvider: string;
  /** Default ACP provider for GATE agents */
  defaultGateProvider: string;
  /** Optional model override for CRAFTER agents (e.g. cheap model for coding tasks) */
  crafterModel?: string;
  /** Optional model override for GATE agents (e.g. balanced model for verification) */
  gateModel?: string;
  /** Optional model override for ROUTA/coordinator agents */
  routaModel?: string;
  /** Default working directory */
  defaultCwd: string;
  /** Server port for MCP URL */
  serverPort?: string;
}

interface DelegationGroup {
  groupId: string;
  parentAgentId: string;
  parentSessionId: string;
  childAgentIds: string[];
  completedAgentIds: Set<string>;
}

/** Append a delegation child session id to the task's session history, deduped. */
function appendDelegationSessionId(
  sessionIds: string[] | undefined,
  sessionId: string,
): string[] {
  const existing = sessionIds ?? [];
  return existing.includes(sessionId) ? [...existing] : [...existing, sessionId];
}

/** An existing delegation binding that can be reused instead of spawning again. */
interface ActiveDelegationBinding {
  agentId: string;
  sessionId: string;
  agentName?: string;
  specialist?: string;
  specialistName?: string;
  provider?: string;
}

const TEAM_LEAD_SPECIALIST_ID = "team-agent-lead";
const TEAM_RUNTIME_LABELS: Record<string, string[]> = {
  "team-researcher": ["Alex", "Sam", "Jack", "Tina", "Eric"],
  "team-frontend-dev": ["Lee", "Taylor", "Felix", "Jay", "Robin"],
  "team-backend-dev": ["Jimmy", "Bill", "Robin", "James", "Jason"],
  "team-qa": ["Chris", "Terry", "Leo", "Ben", "David"],
  "team-ux-designer": ["Kelly", "Kerry", "Emma", "Alice"],
  "team-code-reviewer": ["Mark", "Ryan", "Daniel", "Ray", "Kim"],
  "team-operations": ["Emily", "Ben", "Olivia", "Grace", "Ivan"],
  "team-general-engineer": ["Nick", "Cindy", "Hunk", "Sarah", "Chloe"],
};

function inferRosterRoleId(task: Task, specialistId: string, additionalInstructions?: string): string | undefined {
  if (specialistId.startsWith("team-")) {
    return specialistId;
  }

  const text = [
    task.title,
    task.objective,
    task.scope ?? "",
    task.acceptanceCriteria?.join(" ") ?? "",
    task.testCases?.join(" ") ?? "",
    additionalInstructions ?? "",
  ]
    .join(" ")
    .toLowerCase();

  if (text.includes("research")) return "team-researcher";
  if (text.includes("frontend") || text.includes("react") || text.includes("next.js") || text.includes("tailwind") || text.includes("ui ")) {
    return "team-frontend-dev";
  }
  if (text.includes("backend") || text.includes("api") || text.includes("database") || text.includes("service")) {
    return "team-backend-dev";
  }
  if (text.includes("ux") || text.includes("design") || text.includes("accessibility")) {
    return "team-ux-designer";
  }
  if (text.includes("review") || text.includes("risk") || text.includes("bug")) {
    return "team-code-reviewer";
  }
  if (text.includes("qa") || text.includes("test") || text.includes("verify") || text.includes("validation")) {
    return "team-qa";
  }
  if (text.includes("deploy") || text.includes("ci") || text.includes("infra") || text.includes("monitor") || text.includes("release")) {
    return "team-operations";
  }
  if (specialistId === "gate") return "team-qa";
  if (specialistId === "crafter" || specialistId === "developer") return "team-general-engineer";
  return undefined;
}

async function buildTeamRuntimeMetadata(input: {
  system: RoutaSystem;
  workspaceId: string;
  callerAgentId: string;
  task: Task;
  specialistId: string;
  additionalInstructions?: string;
}): Promise<Record<string, string> | undefined> {
  const caller = await input.system.agentStore.get(input.callerAgentId);
  if (caller?.metadata?.specialist !== TEAM_LEAD_SPECIALIST_ID) {
    return undefined;
  }

  const rosterRoleId = inferRosterRoleId(input.task, input.specialistId, input.additionalInstructions);
  if (!rosterRoleId) {
    return undefined;
  }

  const labels = TEAM_RUNTIME_LABELS[rosterRoleId];
  if (!labels?.length) {
    return { rosterRoleId };
  }

  const agents = await input.system.agentStore.listByWorkspace(input.workspaceId);
  const usedLabels = new Set(
    agents
      .filter((agent) => agent.metadata?.rosterRoleId === rosterRoleId)
      .map((agent) => agent.metadata?.displayLabel)
      .filter((label): label is string => typeof label === "string" && label.length > 0),
  );

  const fallbackIndex = usedLabels.size;
  const displayLabel = labels.find((label) => !usedLabels.has(label))
    ?? `${labels[fallbackIndex % labels.length]} ${Math.floor(fallbackIndex / labels.length) + 1}`;

  return {
    rosterRoleId,
    displayLabel,
  };
}

export class RoutaOrchestrator {
  private system: RoutaSystem;
  private processManager: AcpProcessManager;
  private config: OrchestratorConfig;

  /** Map: agentId → ChildAgentRecord */
  private childAgents = new Map<string, ChildAgentRecord>();
  /** Map: agentId → sessionId */
  private agentSessionMap = new Map<string, string>();
  /** Map: groupId → DelegationGroup */
  private delegationGroups = new Map<string, DelegationGroup>();
  /** Map: callerAgentId → current groupId (for after_all mode) */
  private activeGroupByAgent = new Map<string, string>();
  /** SSE notification handler for sending updates to the frontend */
  private notificationHandler?: (sessionId: string, data: unknown) => void;
  /** Session registration handler for adding child sessions to the UI sidebar */
  private sessionRegistrationHandler?: (session: TeamSessionRegistration) => void;
  /** Map: agentId → file watcher cleanup function */
  private reportFileWatchers = new Map<string, () => void>();
  /** Map: agentId → AgentEventBridge for semantic event conversion */
  private childAgentBridges = new Map<string, AgentEventBridge>();
  /** Map: agentId → set of WorkspaceAgentEvent subscribers */
  private childAgentEventSubscribers = new Map<string, Set<(event: WorkspaceAgentEvent) => void>>();
  /** Map: cwd → AgentMemoryWriter for durable, file-backed agent memory */
  private memoryWriters = new Map<string, AgentMemoryWriter>();
  /** Map: agentId → last completion snapshot written to agent memory */
  private childCompletionSnapshots = new Map<string, ChildCompletionMemorySnapshot>();
  /** Map: agentId → serialized completion memory write pipeline */
  private childCompletionMemoryPromises = new Map<string, Promise<void>>();
  /** Map: agentId → in-flight completion finalizer to dedupe concurrent wake-ups */
  private childCompletionPromises = new Map<string, Promise<void>>();
  /** Map: taskId → in-flight delegation attempt, serializing concurrent delegates per task */
  private taskDelegationGuards = new Map<string, Promise<ToolResult>>();

  constructor(
    system: RoutaSystem,
    processManager: AcpProcessManager,
    config: OrchestratorConfig
  ) {
    this.system = system;
    this.processManager = processManager;
    this.config = config;

    // Listen for report_submitted events to wake parent agents
    this.system.eventBus.on("orchestrator-report-handler", (event) => {
      if (event.type === AgentEventType.REPORT_SUBMITTED) {
        this.handleReportSubmitted(event.agentId, event.data).catch((err) => {
          console.error("[Orchestrator] Error handling report:", err);
        });
      }
    });

    // Listen for automatic lifecycle events emitted by LifecycleNotifier
    this.system.eventBus.on("orchestrator-lifecycle-handler", (event) => {
      const record = this.childAgents.get(event.agentId);
      if (!record) return;

      if (event.type === AgentEventType.AGENT_COMPLETED || event.type === AgentEventType.AGENT_IDLE) {
        this.autoReportIfNeeded(event.agentId).catch((err) => {
          console.error("[Orchestrator] Error handling lifecycle completion:", err);
        });
      } else if (event.type === AgentEventType.AGENT_FAILED || event.type === AgentEventType.AGENT_TIMEOUT) {
        const error = new Error(
          (event.data?.error as string) ?? (event.data?.reason as string) ?? "Agent lifecycle failure"
        );
        this.handleChildError(event.agentId, error).catch((err) => {
          console.error("[Orchestrator] Error handling lifecycle failure:", err);
        });
      }
    });
  }

  private getMemoryWriter(cwd: string): AgentMemoryWriter {
    let writer = this.memoryWriters.get(cwd);
    if (!writer) {
      writer = new AgentMemoryWriter(cwd);
      this.memoryWriters.set(cwd, writer);
    }
    return writer;
  }

  private resolveSessionCwd(sessionId: string, fallbackCwd: string): string {
    return getHttpSessionStore().getSession(sessionId)?.cwd ?? fallbackCwd;
  }

  private hasKnownSessionId(sessionId: string): boolean {
    return sessionId.trim().length > 0 && sessionId !== "unknown";
  }

  private buildCompletionMemorySnapshot(
    childAgentId: string,
    record: ChildAgentRecord,
    source: CompletionSnapshotSource,
    task?: Task,
  ): ChildCompletionMemorySnapshot {
    return {
      sessionId: record.sessionId,
      role: record.role,
      agentId: childAgentId,
      taskId: record.taskId,
      taskTitle: task?.title ?? record.taskId,
      status: task?.status ?? "unknown",
      summary: normalizeOptionalText(task?.completionSummary),
      verificationVerdict: normalizeNullableText(task?.verificationVerdict),
      verificationReport: normalizeNullableText(task?.verificationReport),
      snapshotSource: source,
    };
  }

  private async recordChildCompletionMemory(
    childAgentId: string,
    record: ChildAgentRecord,
    source: CompletionSnapshotSource,
  ): Promise<void> {
    let task: Task | undefined;
    try {
      task = await this.system.taskStore.get(record.taskId);
    } catch (err) {
      console.warn("[Orchestrator] Failed to load task for completion memory:", err);
    }

    const incomingSnapshot = this.buildCompletionMemorySnapshot(childAgentId, record, source, task);
    const pendingWrite = this.childCompletionMemoryPromises.get(childAgentId) ?? Promise.resolve();

    const writePromise = pendingWrite
      .catch(() => undefined)
      .then(async () => {
        const currentSnapshot = this.childCompletionSnapshots.get(childAgentId);
        const nextSnapshot = mergeCompletionSnapshot(currentSnapshot, incomingSnapshot);
        if (completionSnapshotsEqual(currentSnapshot, nextSnapshot)) {
          return;
        }

        try {
          await this.getMemoryWriter(record.cwd).recordChildCompletion({
            sessionId: nextSnapshot.sessionId,
            role: nextSnapshot.role,
            agentId: nextSnapshot.agentId,
            taskId: nextSnapshot.taskId,
            taskTitle: nextSnapshot.taskTitle,
            status: nextSnapshot.status,
            summary: nextSnapshot.summary,
            verificationVerdict: nextSnapshot.verificationVerdict,
            verificationReport: nextSnapshot.verificationReport,
            snapshotSource: nextSnapshot.snapshotSource,
          });
          this.childCompletionSnapshots.set(childAgentId, nextSnapshot);
        } catch (err) {
          console.warn("[Orchestrator] Failed to write completion memory:", err);
        }
      })
      .finally(() => {
        if (this.childCompletionMemoryPromises.get(childAgentId) === writePromise) {
          this.childCompletionMemoryPromises.delete(childAgentId);
        }
      });

    this.childCompletionMemoryPromises.set(childAgentId, writePromise);
    await writePromise;
  }

  private async finalizeChildCompletion(
    childAgentId: string,
    record: ChildAgentRecord,
    source: CompletionSnapshotSource,
  ): Promise<void> {
    await this.recordChildCompletionMemory(childAgentId, record, source);

    if (record.completionHandled) {
      return;
    }

    const inFlight = this.childCompletionPromises.get(childAgentId);
    if (inFlight) {
      await inFlight;
      return;
    }

    const completionPromise = this.handleChildCompletion(childAgentId, record)
      .then(() => {
        record.completionHandled = true;
      })
      .finally(() => {
        this.childCompletionPromises.delete(childAgentId);
      });

    this.childCompletionPromises.set(childAgentId, completionPromise);
    await completionPromise;
  }

  private async scheduleSessionEndCompletion(
    childAgentId: string,
    record: ChildAgentRecord,
  ): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (record.completionHandled) {
      return;
    }

    await this.finalizeChildCompletion(childAgentId, record, "session_end");
  }

  /**
   * Register the mapping between an agent ID and its ACP session ID.
   * Called when a new session is created (e.g., the coordinator's session).
   */
  registerAgentSession(agentId: string, sessionId: string): void {
    this.agentSessionMap.set(agentId, sessionId);
    console.log(
      `[Orchestrator] Registered agent session: ${agentId} → ${sessionId}`
    );
  }

  /**
   * Atomically replace the recoverable Team coordination bindings.
   *
   * Every map mutation is staged on a copy first. The live orchestrator is
   * changed only after the complete restore plan has been constructed, so a
   * failed recovery cannot leave handlers, mappings, or child records half
   * installed.
   */
  restoreTeamRuntimeState(state: TeamRuntimeStateRestore): void {
    const nextAgentSessionMap = new Map(this.agentSessionMap);
    const nextChildAgents = new Map(this.childAgents);

    for (const binding of state.agentSessions) {
      nextAgentSessionMap.set(binding.agentId, binding.sessionId);
    }
    for (const record of state.childAgents) {
      const existing = nextChildAgents.get(record.agentId);
      if (!existing || existing.sessionId !== record.sessionId) {
        nextChildAgents.set(record.agentId, record);
      }
      nextAgentSessionMap.set(record.agentId, record.sessionId);
    }

    this.agentSessionMap = nextAgentSessionMap;
    this.childAgents = nextChildAgents;
    this.notificationHandler = state.notificationHandler;
    this.sessionRegistrationHandler = state.sessionRegistrationHandler;
  }

  /**
   * Set the notification handler for forwarding SSE updates.
   */
  setNotificationHandler(
    handler: (sessionId: string, data: unknown) => void
  ): void {
    this.notificationHandler = handler;
  }

  /**
   * Subscribe to WorkspaceAgentEvents emitted by a specific child agent.
   * Returns an unsubscribe function.
   */
  subscribeToChildAgentEvents(
    agentId: string,
    handler: (event: WorkspaceAgentEvent) => void
  ): () => void {
    let subscribers = this.childAgentEventSubscribers.get(agentId);
    if (!subscribers) {
      subscribers = new Set();
      this.childAgentEventSubscribers.set(agentId, subscribers);
    }
    subscribers.add(handler);
    return () => subscribers!.delete(handler);
  }

  /**
   * Set the session registration handler for adding child sessions to the UI sidebar.
   */
  setSessionRegistrationHandler(
    handler: (session: TeamSessionRegistration) => void
  ): void {
    this.sessionRegistrationHandler = handler;
  }

  /**
   * Delegate a task to a new agent by spawning a real ACP process.
   * This is the enhanced version of delegate_task that actually creates a running agent.
   */
  async delegateTaskWithSpawn(
    params: DelegateWithSpawnParams
  ): Promise<ToolResult> {
    const { taskId, callerAgentId, specialist: specialistInput } = params;

    // 0. Check delegation depth (prevents infinite recursion)
    const depthCheck = await checkDelegationDepth(this.system.agentStore, callerAgentId);
    if (!depthCheck.allowed) {
      return errorResult(depthCheck.error!);
    }

    // 1. Resolve specialist config
    const specialistConfig = this.resolveSpecialist(specialistInput);
    if (!specialistConfig) {
      return errorResult(
        `Unknown specialist: ${specialistInput}. Use "CRAFTER", "GATE", "crafter", or "gate".`
      );
    }

    // Concurrent delegation attempts for the same task are serialized inside
    // this orchestrator instance.
    return this.withTaskDelegationGuard(taskId, () =>
      this.executeTaskDelegation(params, specialistConfig, depthCheck.currentDepth),
    );
  }

  /**
   * Execute one delegation attempt inside the per-task guard:
   * re-read the task, reuse an active binding when one exists, create the
   * pending agent and child session WITHOUT prompting, persist the binding,
   * and only then activate the agent and dispatch the prompt.
   */
  private async executeTaskDelegation(
    params: DelegateWithSpawnParams,
    specialistConfig: SpecialistConfig,
    parentDepth: number,
  ): Promise<ToolResult> {
    const {
      taskId,
      callerAgentId,
      callerSessionId,
      workspaceId,
      additionalInstructions,
      waitMode = "immediate",
    } = params;

    // 2. Re-read the task inside the per-task guard.
    let task: Task | undefined;
    try {
      task = await this.system.taskStore.get(taskId);
    } catch (err) {
      return errorResult(
        `Failed to load task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!task) {
      // Check if the taskId looks like a name instead of a UUID
      const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId);
      const hint = looksLikeUuid
        ? `Use list_tasks to see available tasks, or create_task to create a new one.`
        : `The taskId "${taskId}" looks like a task name, not a UUID. ` +
          `You must use the UUID returned by create_task. ` +
          `First call create_task to create tasks, then use the returned taskId (UUID format like "dda97509-b414-4c50-9835-73a1ec2f..."). ` +
          `Alternatively, use convert_task_blocks to convert @@@task blocks into tasks, or list_tasks to see existing tasks.`;
      return errorResult(`Task not found: ${taskId}. ${hint}`);
    }

    // 2.5. Reuse an existing active binding (idempotent re-delegation): never
    // spawn a duplicate agent/session while the previous delegation is live.
    const existingBinding = await this.resolveActiveDelegationBinding(task);
    if (existingBinding) {
      return this.buildDelegatedResult({
        task,
        agentId: existingBinding.agentId,
        sessionId: existingBinding.sessionId,
        agentName: existingBinding.agentName,
        specialistId: existingBinding.specialist ?? specialistConfig.id,
        specialistName: existingBinding.specialistName,
        provider: existingBinding.provider,
        waitMode,
        reused: true,
      });
    }

    // 3. Determine provider
    const provider =
      params.provider ??
      (specialistConfig.role === AgentRole.CRAFTER
        ? this.config.defaultCrafterProvider
        : this.config.defaultGateProvider);

    // A single server can host Team runs for several repositories. The
    // orchestrator itself is a singleton, so its default cwd may belong to an
    // earlier run. Unless the caller explicitly overrides it, inherit the
    // parent session's cwd instead.
    const cwd = params.cwd ?? this.resolveSessionCwd(callerSessionId, this.config.defaultCwd);

    // 4. Create agent record with delegation depth metadata
    const agentName = `${specialistConfig.id}-${task.title
      .slice(0, 30)
      .replace(/\s+/g, "-")
      .toLowerCase()}`;

    const runtimeRosterMetadata = await buildTeamRuntimeMetadata({
      system: this.system,
      workspaceId,
      callerAgentId,
      task,
      specialistId: specialistConfig.id,
      additionalInstructions,
    });
    const taskFingerprint = buildTaskFingerprint(task, workspaceId);

    // Build metadata including delegation depth
    const agentMetadata = buildAgentMetadata(
      calculateChildDepth(parentDepth),
      callerAgentId,
      specialistConfig.id,
      runtimeRosterMetadata,
    );

    const agentResult = await this.system.tools.createAgent({
      name: agentName,
      role: specialistConfig.role,
      workspaceId,
      parentId: callerAgentId,
      modelTier: specialistConfig.defaultModelTier,
      metadata: agentMetadata,
    });

    if (!agentResult.success || !agentResult.data) {
      return errorResult(`Failed to create agent: ${agentResult.error}`);
    }

    const agentId = (agentResult.data as { agentId: string }).agentId;

    // 4.5. Build trace digest from parent session for specialist context
    let enrichedAdditionalContext = additionalInstructions;
    try {
      const traceReader = new TraceReader(cwd);
      const parentTraces = await traceReader.query({ sessionId: callerSessionId, limit: 500 });
      if (parentTraces.length > 0) {
        const digest = buildTraceRunDigest(callerSessionId, parentTraces);
        const formatted = formatDigestForRole(digest, specialistConfig.role as AgentRole);
        if (formatted) {
          enrichedAdditionalContext = enrichedAdditionalContext
            ? `${enrichedAdditionalContext}\n\n${formatted}`
            : formatted;
          console.log(
            `[Orchestrator] Trace digest injected for ${specialistConfig.role} delegation (session=${callerSessionId}): ` +
            `${digest.totalEvents} events, ${digest.filesTouched.length} files, ` +
            `${digest.errorCount} errors, ${digest.verificationSignals.length} verifications, ` +
            `${digest.churnMarkers.length} churn markers, ${digest.confidenceFlags.length} confidence flags`,
          );
        }
      }
    } catch {
      // Trace digest is best-effort; don't block delegation on failure
    }

    try {
      const learned = await loadLearnedPlaybook(cwd, taskFingerprint, task.title, workspaceId);
      if (learned) {
        const formatted = formatPlaybookForRole(learned, specialistConfig.role as AgentRole);
        if (formatted) {
          enrichedAdditionalContext = enrichedAdditionalContext
            ? `${formatted}\n\n${enrichedAdditionalContext}`
            : formatted;
          console.log(
            `[Orchestrator] Learned playbook injected for ${specialistConfig.role} ` +
              `(fingerprint=${taskFingerprint}, runs=${learned.sampleSize})`,
          );
        }
      }
    } catch {
      // Learned playbook injection is best-effort
    }

    // 5. Build the delegation prompt
    const delegationPrompt = buildDelegationPrompt({
      specialist: specialistConfig,
      agentId,
      taskId,
      taskTitle: task.title,
      taskContent:
        `## Objective\n${task.objective}\n` +
        (task.scope ? `\n## Scope\n${task.scope}\n` : "") +
        (task.acceptanceCriteria
          ? `\n## Definition of Done\n${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n`
          : "") +
        (task.testCases
          ? `\n## Test Cases\n${task.testCases.map((c) => `- ${c}`).join("\n")}\n`
          : "") +
        (task.verificationCommands
          ? `\n## Verification\n${task.verificationCommands.map((c) => `- \`${c}\``).join("\n")}\n`
          : ""),
      parentAgentId: callerAgentId,
      additionalContext: enrichedAdditionalContext,
    });

    // 6. Create the child session BEFORE persisting the binding, but do not
    // dispatch the initial prompt yet: the prompt may only be sent after the
    // binding is durable.
    const childSessionId = uuidv4();
    let createdSession: { sandboxId?: string; acpSessionId: string };
    try {
      createdSession = await this.createChildAgentSession(
        childSessionId,
        agentId,
        provider,
        cwd,
        callerSessionId,
        workspaceId,
      );
    } catch (err) {
      // The binding was never persisted: fail the fresh agent and leave the
      // task in its previous state.
      await this.system.agentStore.updateStatus(agentId, AgentStatus.ERROR);
      return errorResult(
        `Failed to spawn agent process: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 7. Persist the delegation binding before activating the child. The
    // per-task guard serializes delegates in this runtime; task.sessionId
    // remains the creating session and child sessions live in sessionIds.
    const teamRunId = task.teamRunId ?? (await this.resolveTeamRunIdForCaller(callerSessionId));
    const sessionIds = appendDelegationSessionId(task.sessionIds, childSessionId);
    task.assignedTo = agentId;
    task.status = TaskStatus.IN_PROGRESS;
    task.sessionIds = sessionIds;
    if (teamRunId) task.teamRunId = teamRunId;
    task.updatedAt = new Date();
    try {
      await this.system.taskStore.save(task);
    } catch (err) {
      await this.releaseUnboundChildResources(agentId, childSessionId);
      return errorResult(
        `Failed to persist delegation binding for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 8. Activate the agent and dispatch the initial prompt ONLY after the
    // binding has been persisted.
    this.dispatchChildAgentEvent(agentId, makeStartedEvent(childSessionId, provider));
    await this.system.agentStore.updateStatus(agentId, AgentStatus.ACTIVE);
    try {
      await this.dispatchChildInitialPrompt(
        agentId,
        childSessionId,
        createdSession.acpSessionId,
        provider,
        delegationPrompt,
      );
    } catch (err) {
      // Keep the failed session recorded in sessionIds for diagnostics; mark
      // the agent ERROR and move the task to BLOCKED through the unified
      // status transition.
      await this.system.agentStore.updateStatus(agentId, AgentStatus.ERROR);
      const current = await this.system.taskStore.get(taskId).catch(() => undefined);
      if (
        current?.assignedTo === agentId &&
        current.sessionIds?.includes(childSessionId) &&
        current.status === TaskStatus.IN_PROGRESS
      ) {
        const boardColumns = await loadTaskBoardColumns(this.system, current);
        applyTaskStatusTransition(current, TaskStatus.BLOCKED, boardColumns);
        await this.system.taskStore.save(current);
      }
      return errorResult(
        `Failed to start agent process: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const childSandboxId = createdSession.sandboxId;

    // 8. Track the child agent
    const record: ChildAgentRecord = {
      agentId,
      sessionId: childSessionId,
      parentAgentId: callerAgentId,
      parentSessionId: callerSessionId,
      taskId,
      role: specialistConfig.role,
      provider,
      cwd,
      workspaceId,
    };
    this.childAgents.set(agentId, record);
    this.agentSessionMap.set(agentId, childSessionId);

    // 8.5 Register child session in UI sidebar
    const sessionDisplayName = `${task.title.slice(0, 50)}`;
    if (this.sessionRegistrationHandler) {
      this.sessionRegistrationHandler({
        sessionId: childSessionId,
        name: sessionDisplayName,
        cwd,
        workspaceId,
        routaAgentId: agentId,
        provider,
        role: specialistConfig.role,
        specialistId: specialistConfig.id,
        parentSessionId: callerSessionId,
        sandboxId: childSandboxId,
      });
    }

    // 9. Handle wait mode
    if (waitMode === "after_all") {
      let groupId = this.activeGroupByAgent.get(callerAgentId);
      if (!groupId) {
        groupId = `delegation-group-${uuidv4()}`;
        this.activeGroupByAgent.set(callerAgentId, groupId);
        this.delegationGroups.set(groupId, {
          groupId,
          parentAgentId: callerAgentId,
          parentSessionId: callerSessionId,
          childAgentIds: [],
          completedAgentIds: new Set(),
        });
      }
      const group = this.delegationGroups.get(groupId)!;
      group.childAgentIds.push(agentId);
    }

    // 10. Emit event
    this.system.eventBus.emit({
      type: AgentEventType.TASK_ASSIGNED,
      agentId,
      workspaceId,
      data: {
        taskId,
        callerAgentId,
        taskTitle: task.title,
        provider,
        specialist: specialistConfig.id,
      },
      timestamp: new Date(),
    });

    try {
      const childMemoryWriter = this.getMemoryWriter(cwd);
      const memoryWrites = [
        childMemoryWriter.recordChildSessionStart({
          sessionId: childSessionId,
          role: specialistConfig.role,
          agentId,
          taskId,
          taskTitle: task.title,
          parentAgentId: callerAgentId,
          provider,
          initialPrompt: delegationPrompt,
        }),
      ];

      if (this.hasKnownSessionId(callerSessionId)) {
        const parentMemoryWriter = this.getMemoryWriter(this.resolveSessionCwd(callerSessionId, cwd));
        memoryWrites.push(
          parentMemoryWriter.recordDelegation({
            sessionId: callerSessionId,
            parentAgentId: callerAgentId,
            childAgentId: agentId,
            childRole: specialistConfig.role,
            taskId,
            taskTitle: task.title,
            provider,
            waitMode,
          }),
        );
      } else {
        console.warn(
          `[Orchestrator] Skipping parent delegation memory for ${agentId} because caller session is unknown`,
        );
      }

      await Promise.all(memoryWrites);
    } catch (err) {
      console.warn("[Orchestrator] Failed to persist agent memory:", err);
    }

    console.log(
      `[Orchestrator] Delegated task "${task.title}" to ${specialistConfig.name} agent ${agentId} (provider: ${provider})`
    );

    return this.buildDelegatedResult({
      task,
      agentId,
      sessionId: childSessionId,
      agentName,
      specialistId: specialistConfig.id,
      specialistName: specialistConfig.name,
      provider,
      waitMode,
      reused: false,
    });
  }

  private withTaskDelegationGuard(
    taskId: string,
    work: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    const previous = this.taskDelegationGuards.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const tracked = next.finally(() => {
      if (this.taskDelegationGuards.get(taskId) === tracked) {
        this.taskDelegationGuards.delete(taskId);
      }
    });
    this.taskDelegationGuards.set(taskId, tracked);
    return next;
  }

  private async resolveActiveDelegationBinding(
    task: Task,
  ): Promise<ActiveDelegationBinding | undefined> {
    if (!task.assignedTo || task.status !== TaskStatus.IN_PROGRESS) return undefined;

    let agent: Agent | undefined;
    try {
      agent = await this.system.agentStore.get(task.assignedTo);
    } catch {
      return undefined;
    }
    if (!agent || agent.status !== AgentStatus.ACTIVE) return undefined;
    const activeAgent = agent;

    const specialistId = activeAgent.metadata?.specialist;
    const describe = (sessionId: string, provider?: string): ActiveDelegationBinding => ({
      agentId: activeAgent.id,
      sessionId,
      agentName: activeAgent.name,
      specialist: specialistId,
      specialistName: specialistId ? getSpecialistById(specialistId)?.name : undefined,
      provider,
    });

    const record = this.childAgents.get(activeAgent.id);
    if (record) return describe(record.sessionId, record.provider);

    // Runtime tracking may be unavailable (e.g. after a restart): fall back to
    // the session registry, most recent child session first.
    const sessionStore = getHttpSessionStore();
    for (const sessionId of [...(task.sessionIds ?? [])].reverse()) {
      const session = sessionStore.getSession(sessionId);
      if (session && session.acpStatus !== "error") {
        return describe(sessionId);
      }
    }
    return undefined;
  }

  /**
   * Resolve the owning Team Run root for the caller session so delegated tasks
   * keep their Team Run binding even when the task was created without one.
   * Best-effort: resolution failures never block delegation.
   */
  private async resolveTeamRunIdForCaller(callerSessionId: string): Promise<string | undefined> {
    if (!this.hasKnownSessionId(callerSessionId)) return undefined;
    try {
      const store = getHttpSessionStore();
      return await resolveOwningTeamRunIdFromSessions(callerSessionId, async () => {
        await store.hydrateFromDb();
        return store.listSessions();
      });
    } catch {
      return undefined;
    }
  }

  private buildDelegatedResult(input: {
    task: Task;
    agentId: string;
    sessionId: string;
    agentName?: string;
    specialistId: string;
    specialistName?: string;
    provider?: string;
    waitMode: "immediate" | "after_all";
    reused: boolean;
  }): ToolResult {
    const waitMessage =
      input.waitMode === "after_all"
        ? "You will be notified when ALL delegated agents in this group complete."
        : "You will be notified when this agent completes.";
    const specialistLabel = input.specialistName ?? input.specialistId;
    return successResult({
      agentId: input.agentId,
      taskId: input.task.id,
      ...(input.agentName ? { agentName: input.agentName } : {}),
      specialist: input.specialistId,
      ...(input.provider ? { provider: input.provider } : {}),
      sessionId: input.sessionId,
      waitMode: input.waitMode,
      status: "delegated",
      message: input.reused
        ? `Task "${input.task.title}" is already delegated to an active ${specialistLabel} agent. ${waitMessage}`
        : `Task "${input.task.title}" delegated to ${specialistLabel} agent. ${waitMessage}`,
    });
  }

  private async releaseUnboundChildResources(agentId: string, sessionId: string): Promise<void> {
    try {
      await this.processManager.killSession(sessionId);
    } catch (err) {
      console.warn(`[Orchestrator] Failed to stop unbound child session ${sessionId}:`, err);
    }
    this.childAgentBridges.get(agentId)?.cleanup();
    this.childAgentBridges.delete(agentId);
    this.cleanupReportWatcher(agentId);
    try {
      await this.system.agentStore.updateStatus(agentId, AgentStatus.ERROR);
    } catch {
      // Best-effort: the agent record may already be gone.
    }
  }

  private async createChildAgentSession(
    sessionId: string,
    agentId: string,
    provider: string,
    cwd: string,
    parentSessionId: string,
    workspaceId?: string,
  ): Promise<{ sandboxId?: string; acpSessionId: string }> {
    const result = await createDelegatedChildSession({
      sessionId,
      agentId,
      provider,
      cwd,
      parentSessionId,
      workspaceId,
      system: this.system,
      processManager: this.processManager,
      serverPort: this.detectServerPort(),
      notificationSink: this.notificationHandler,
      onCompletionUpdate: (id, params) => this.checkForCompletion(id, params),
      onAgentEvent: (id, event) => this.dispatchChildAgentEvent(id, event),
      watchForReports: (id, workdir) => this.watchForReportFiles(id, workdir),
    });
    this.childAgentBridges.set(agentId, result.bridge);
    return result;
  }

  private dispatchChildInitialPrompt(
    agentId: string,
    sessionId: string,
    acpSessionId: string,
    provider: string,
    prompt: string,
  ): Promise<void> {
    return dispatchDelegatedChildPrompt({
      agentId,
      sessionId,
      acpSessionId,
      provider,
      prompt,
      processManager: this.processManager,
      onComplete: (id) => void this.autoReportIfNeeded(id),
      onError: (id, error) => this.handleChildError(id, error),
    });
  }

  /**
   * Auto-report to parent if the child agent finished without calling report_to_parent.
   * This is a fallback mechanism for agents that complete their work but forget to report.
   */
  private async autoReportIfNeeded(childAgentId: string): Promise<void> {
    // Wait a short time to allow report_to_parent to be processed first
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const record = this.childAgents.get(childAgentId);
    if (!record || record.completionHandled) return;

    const agent = await this.system.agentStore.get(childAgentId);
    if (!agent) return;

    // If the agent is already completed (report_to_parent was called), skip
    if (agent.status === AgentStatus.COMPLETED) {
      console.log(
        `[Orchestrator] Agent ${childAgentId} already completed, skipping auto-report`
      );
      return;
    }

    console.log(
      `[Orchestrator] Agent ${childAgentId} finished without calling report_to_parent, auto-reporting`
    );

    // Auto-report success (the prompt completed without error)
    await this.system.tools.reportToParent({
      agentId: childAgentId,
      report: {
        agentId: childAgentId,
        taskId: record.taskId,
        summary: "Reported completion back to lead (auto-submitted by orchestrator).",
        success: true,
      },
    });

    // Trigger completion handling
    await this.finalizeChildCompletion(childAgentId, record, "auto");
  }

  /**
   * Dispatch a WorkspaceAgentEvent to all subscribers for a child agent.
   */
  private dispatchChildAgentEvent(agentId: string, event: WorkspaceAgentEvent): void {
    const subscribers = this.childAgentEventSubscribers.get(agentId);
    if (!subscribers || subscribers.size === 0) return;
    for (const handler of subscribers) {
      try {
        handler(event);
      } catch {
        // subscriber errors must not break the notification pipeline
      }
    }
  }

  /**
   * Detect the actual server port.
   */
  private detectServerPort(): string {
    if (this.config.serverPort) return this.config.serverPort;
    if (process.env.PORT) return process.env.PORT;
    return "3000";
  }

  /**
   * Watch for .report_to_parent_*.json files in a directory.
   * Claude Code sometimes writes these files instead of calling the MCP tool.
   */
  private watchForReportFiles(agentId: string, cwd: string): void {
    // Clean up existing watcher if any
    this.cleanupReportWatcher(agentId);

    try {
      const watcher = fs.watch(cwd, { persistent: false }, (eventType, filename) => {
        if (!filename || !filename.startsWith(".report_to_parent_") || !filename.endsWith(".json")) {
          return;
        }

        const filePath = path.join(cwd, filename);
        console.log(`[Orchestrator] Detected report file: ${filePath} for agent ${agentId}`);

        // Read and process the file
        this.processReportFile(agentId, filePath);
      });

      // Store cleanup function
      this.reportFileWatchers.set(agentId, () => {
        watcher.close();
      });

      console.log(`[Orchestrator] Watching for report files in ${cwd} for agent ${agentId}`);
    } catch (err) {
      console.warn(`[Orchestrator] Failed to set up file watcher for ${cwd}:`, err);
    }
  }

  /**
   * Process a .report_to_parent_*.json file.
   */
  private async processReportFile(agentId: string, filePath: string): Promise<void> {
    try {
      // Wait a moment for the file to be fully written
      await new Promise((resolve) => setTimeout(resolve, 100));

      const content = fs.readFileSync(filePath, "utf-8");
      const report = JSON.parse(content) as {
        agentId?: string;
        taskId?: string;
        summary?: string;
        filesModified?: string[];
        verificationResults?: string;
        success?: boolean;
      };

      console.log(`[Orchestrator] Processing report file for agent ${agentId}:`, report);

      // Get the child agent record
      const record = this.childAgents.get(agentId);
      if (!record) {
        console.warn(`[Orchestrator] No record for agent ${agentId}, ignoring report file`);
        return;
      }

      // Call reportToParent with the file contents
      await this.system.tools.reportToParent({
        agentId: report.agentId ?? agentId,
        report: {
          agentId: report.agentId ?? agentId,
          taskId: report.taskId ?? record.taskId,
          summary: report.summary ?? "Completed (from report file)",
          filesModified: report.filesModified,
          verificationResults: report.verificationResults,
          success: report.success ?? true,
        },
      });

      // Clean up the file
      try {
        fs.unlinkSync(filePath);
        console.log(`[Orchestrator] Cleaned up report file: ${filePath}`);
      } catch {
        // Ignore cleanup errors
      }

      // Clean up the watcher
      this.cleanupReportWatcher(agentId);
    } catch (err) {
      console.error(`[Orchestrator] Error processing report file ${filePath}:`, err);
    }
  }

  /**
   * Clean up report file watcher for an agent.
   */
  private cleanupReportWatcher(agentId: string): void {
    const cleanup = this.reportFileWatchers.get(agentId);
    if (cleanup) {
      cleanup();
      this.reportFileWatchers.delete(agentId);
    }
  }

  /**
   * Check session/update notifications for signs of agent completion.
   * This is a fallback in case the agent doesn't call report_to_parent.
   */
  private checkForCompletion(
    agentId: string,
    params: Record<string, unknown>
  ): void {
    // Check if the session has ended (provider signals completion)
    const update = params.update as Record<string, unknown> | undefined;
    if (update?.sessionUpdate === "completed" || update?.sessionUpdate === "ended") {
      console.log(
        `[Orchestrator] Detected session completion for agent ${agentId}`
      );
      // The agent's session ended without calling report_to_parent
      // Treat as a successful completion with no formal report
      const record = this.childAgents.get(agentId);
      if (record) {
        this.scheduleSessionEndCompletion(agentId, record).catch((err) => {
          console.error("[Orchestrator] Error handling completion:", err);
        });
      }
    }
  }

  /**
   * Handle a report_submitted event from a child agent.
   * This is triggered when the child calls report_to_parent via MCP.
   */
  private async handleReportSubmitted(
    childAgentId: string,
    _data: Record<string, unknown>
  ): Promise<void> {
    const record = this.childAgents.get(childAgentId);
    if (!record) {
      console.log(
        `[Orchestrator] Report from unknown child agent ${childAgentId}, ignoring`
      );
      return;
    }

    await this.finalizeChildCompletion(childAgentId, record, "reported");
  }

  /**
   * Handle child agent completion: check groups or immediately wake parent.
   */
  private async handleChildCompletion(
    childAgentId: string,
    record: ChildAgentRecord,
  ): Promise<void> {
    let task: Task | undefined;
    try {
      task = await this.system.taskStore.get(record.taskId);
    } catch (err) {
      console.warn("[Orchestrator] Failed to load task for completion outcome:", err);
    }

    try {
      const traceReader = new TraceReader(record.cwd);
      const traces = await traceReader.query({ sessionId: record.sessionId, limit: 1000 });
      if (traces.length > 0) {
        const digest = buildTraceRunDigest(record.sessionId, traces);
        const outcome = buildRunOutcome({
          cwd: record.cwd,
          task,
          taskId: record.taskId,
          sessionId: record.sessionId,
          workspaceId: record.workspaceId,
          role: record.role,
          provider: record.provider,
          traces,
          digest,
        });
        await saveRunOutcome(record.cwd, outcome);
        await syncLearnedPlaybookArtifact(
          record.cwd,
          outcome.fingerprint,
          outcome.taskTitle,
          outcome.workspaceId,
        );
      }
    } catch (err) {
      console.warn("[Orchestrator] Failed to persist trace run outcome:", err);
    }

    // Clean up the report file watcher
    this.cleanupReportWatcher(childAgentId);

    // Clean up AgentEventBridge for this child
    this.childAgentBridges.get(childAgentId)?.cleanup();
    this.childAgentBridges.delete(childAgentId);
    this.childAgentEventSubscribers.delete(childAgentId);

    // Check if this child is part of an after_all group
    for (const [groupId, group] of this.delegationGroups.entries()) {
      if (group.childAgentIds.includes(childAgentId)) {
        group.completedAgentIds.add(childAgentId);
        console.log(
          `[Orchestrator] Agent ${childAgentId} completed in group ${groupId} ` +
            `(${group.completedAgentIds.size}/${group.childAgentIds.length})`
        );

        // Check if all agents in the group are done
        if (group.completedAgentIds.size >= group.childAgentIds.length) {
          console.log(
            `[Orchestrator] All agents in group ${groupId} completed, waking parent`
          );
          await this.wakeParent(record, groupId);
          this.delegationGroups.delete(groupId);
          this.activeGroupByAgent.delete(record.parentAgentId);
        }
        return;
      }
    }

    // Immediate mode: wake parent right away
    console.log(
      `[Orchestrator] Child agent ${childAgentId} completed, waking parent ${record.parentAgentId}`
    );
    await this.wakeParent(record);
  }

  /**
   * Wake a parent agent by sending a completion prompt to its session.
   */
  private async wakeParent(
    record: ChildAgentRecord,
    groupId?: string
  ): Promise<void> {
    const { parentAgentId, parentSessionId, taskId } = record;

    // Build a wake-up message with completion details
    let wakeMessage: string;

    if (groupId) {
      const group = this.delegationGroups.get(groupId);
      const reports = [];
      if (group) {
        for (const childId of group.childAgentIds) {
          const childRecord = this.childAgents.get(childId);
          if (childRecord) {
            const agent = await this.system.agentStore.get(childId);
            const task = await this.system.taskStore.get(childRecord.taskId);
            reports.push(
              `- **${agent?.name ?? childId}** (${childRecord.role}): ` +
                `Task "${task?.title ?? childRecord.taskId}" → ` +
                `${task?.status ?? "unknown"}`
            );
            // Include completion summary if available
            if (task?.completionSummary) {
              reports.push(`  Summary: ${task.completionSummary}`);
            }
          }
        }
      }
      wakeMessage =
        `## Delegation Group Complete\n\n` +
        `All ${group?.childAgentIds.length ?? 0} delegated agents have completed:\n\n` +
        reports.join("\n") +
        `\n\nReview the results and decide next steps. ` +
        `You may want to delegate a GATE (verifier) agent to validate the work.`;
    } else {
      const agent = await this.system.agentStore.get(record.agentId);
      const task = await this.system.taskStore.get(taskId);
      wakeMessage =
        `## Agent Completion Report\n\n` +
        `**Agent:** ${agent?.name ?? record.agentId} (${record.role})\n` +
        `**Task:** ${task?.title ?? taskId}\n` +
        `**Status:** ${task?.status ?? "unknown"}\n` +
        (task?.completionSummary
          ? `**Summary:** ${task.completionSummary}\n`
          : "") +
        (task?.verificationVerdict
          ? `**Verification:** ${task.verificationVerdict}\n`
          : "") +
        (task?.verificationReport
          ? `**Report:**\n${task.verificationReport}\n`
          : "") +
        `\nReview the results and decide next steps.`;
    }

    // Send a task completion notification to update the UI
    if (this.notificationHandler && !groupId) {
      const task = await this.system.taskStore.get(taskId);
      this.notificationHandler(parentSessionId, {
        sessionId: parentSessionId,
        update: {
          sessionUpdate: "task_completion",
          taskId,
          taskTitle: task?.title ?? taskId,
          taskStatus: task?.status ?? "unknown",
          completionSummary: task?.completionSummary,
          agentId: record.agentId,
          agentRole: record.role,
        },
      });
    }

    // Deliver the report through the unified recover-aware prompt entry. The
    // deliveryId is deterministic for the (parent, child, task) triple plus
    // the count of previously DELIVERED reports, so retries after a crash
    // reuse the same identity and `appendHistoryOnce` never appends the
    // report twice. This path also recovers a suspended Lead session instead
    // of silently dropping the report.
    //
    // A delivery failure PROPAGATES on purpose: leaving the completion
    // unhandled is what lets the session-end fallback retry the wake, and the
    // recorded delivery event stays WITHOUT a receipt so the retry reuses the
    // same delivery identity (at-least-once, never double-append).
    const deliveryId = await deriveNextTeamReportDeliveryId({
      parentSessionId: record.parentSessionId,
      childSessionId: record.sessionId,
      taskId: record.taskId,
    });
    try {
      await this.sendPromptToSession(parentSessionId, wakeMessage, deliveryId);
    } catch (err) {
      console.error(
        `[Orchestrator] Failed to deliver completion report ${deliveryId} to parent session ${parentSessionId}; keeping delivery retryable`,
        err,
      );
      throw err;
    }

    // Provider accepted the report prompt: persist the durable `delivered`
    // receipt, then clear the in-flight delivery marker. Only a PROVEN
    // receipt (newly appended, or already present from an earlier attempt)
    // counts: a failed receipt write must retain the child runtime so the
    // hand-off stays retryable instead of being released on an unproven
    // delivery.
    let receiptPersisted = false;
    try {
      const receiptOutcome = await appendSessionNotificationEventOnce(
        parentSessionId,
        buildPromptDeliveryReceiptNotification(parentSessionId, deliveryId),
      );
      receiptPersisted = receiptOutcome.status === "appended" || receiptOutcome.status === "duplicate";
      if (!receiptPersisted) {
        console.error(
          `[Orchestrator] Delivery receipt for ${deliveryId} is NOT durable (status: ${receiptOutcome.status}${
            receiptOutcome.status === "unavailable" ? `, error: ${receiptOutcome.error}` : ""
          }); retaining child runtime for retry`,
        );
      }
    } catch (err) {
      console.error(
        `[Orchestrator] Failed to persist delivery receipt for ${deliveryId}; retaining child runtime for retry:`,
        err,
      );
    } finally {
      finalizePromptDelivery(deliveryId);
    }

    console.log(
      `[Orchestrator] Woke parent agent ${parentAgentId} with completion report (${deliveryId})`
    );

    // Durable report acceptance is the completed-child release trigger. The
    // finalizer re-checks every safety gate (streaming, pending interaction,
    // dependencies, recovery readiness, durable receipt) and retains the
    // session record for a later retry when any gate fails.
    if (receiptPersisted) {
      await releaseCompletedChildRuntime(record.sessionId);
    }
  }

  /**
   * Send a prompt to an existing ACP session through the unified
   * recover-aware entry point (`dispatchSessionPrompt` →
   * `handleSessionPrompt` → `ensureSessionRuntime`). A dead or suspended
   * runtime is recovered here instead of dropping the prompt; the optional
   * `promptId` makes the delivery durably idempotent.
   */
  private async sendPromptToSession(
    sessionId: string,
    prompt: string,
    promptId?: string
  ): Promise<void> {
    const { dispatchSessionPrompt } = await import("@/core/acp/session-prompt");
    await dispatchSessionPrompt({
      sessionId,
      prompt: [{ type: "text", text: prompt }],
      ...(promptId ? { promptId } : {}),
    });
  }

  /**
   * Handle a child agent error.
   */
  private async handleChildError(
    agentId: string,
    error: unknown
  ): Promise<void> {
    const record = this.childAgents.get(agentId);
    if (!record) return;

    await this.system.agentStore.updateStatus(agentId, AgentStatus.ERROR);
    const task = await this.system.taskStore.get(record.taskId);
    if (task) {
      task.status = TaskStatus.NEEDS_FIX;
      task.completionSummary = `Error: ${error instanceof Error ? error.message : String(error)}`;
      task.updatedAt = new Date();
      await this.system.taskStore.save(task);
    }

    // Emit error event
    this.system.eventBus.emit({
      type: AgentEventType.AGENT_ERROR,
      agentId,
      workspaceId: record.workspaceId,
      data: {
        parentAgentId: record.parentAgentId,
        error: error instanceof Error ? error.message : String(error),
      },
      timestamp: new Date(),
    });

    // Wake parent with error report
    await this.finalizeChildCompletion(agentId, record, "error");
  }

  /**
   * Resolve specialist config from a string (role name or specialist ID).
   */
  private resolveSpecialist(input: string): SpecialistConfig | undefined {
    // Try by role name (e.g., "CRAFTER", "GATE")
    const role = input.toUpperCase() as AgentRole;
    if (Object.values(AgentRole).includes(role)) {
      return getSpecialistByRole(role);
    }
    // Try by specialist ID (e.g., "crafter", "gate")
    return getSpecialistById(input);
  }

  /**
   * Get the session ID for an agent.
   */
  getSessionForAgent(agentId: string): string | undefined {
    return this.agentSessionMap.get(agentId);
  }

  /**
   * Get all child agent records for a parent.
   */
  getChildAgents(parentAgentId: string): ChildAgentRecord[] {
    return Array.from(this.childAgents.values()).filter(
      (r) => r.parentAgentId === parentAgentId
    );
  }

  /**
   * Clean up resources for a session.
   */
  cleanup(sessionId: string): void {
    // Find and clean up child agents
    for (const [agentId, record] of this.childAgents.entries()) {
      if (
        record.parentSessionId === sessionId ||
        record.sessionId === sessionId
      ) {
        void this.processManager.killSession(record.sessionId);
        this.childAgents.delete(agentId);
        this.agentSessionMap.delete(agentId);
      }
    }
  }
}
