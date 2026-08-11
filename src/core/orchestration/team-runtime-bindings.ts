/**
 * Team runtime bindings.
 *
 * Two responsibilities:
 *
 * 1. `installTeamOrchestrationHandlers` — the orchestrator wiring every Team
 *    Lead session needs: notification forwarding into the durable history and
 *    child-session registration. Extracted verbatim from the ROUTA branch of
 *    `src/app/api/acp/acp-session-create.ts` so creation and restoration use
 *    the exact same handlers.
 *
 * 2. `restoreTeamRuntimeBindings` — rebuilds the in-memory coordination state
 *    of a Team Run from DURABLE records after a provider/runtime restart or a
 *    Routa restart. It re-registers the Lead's agent↔session mapping, the
 *    descendant tree found through durable `parent_session_id` links, and the
 *    child agent records needed for completion handling.
 *
 *    Restoration is ALL-OR-NOTHING: it either rebuilds every binding — Lead
 *    agent mapping, descendant session mappings, child records, notification
 *    handler, child-session-registration handler, Team MCP profile — or it
 *    reports a structured `failure` (missing durable metadata, or an
 *    incomplete restoration). It never mutates orchestrator state partially
 *    and never hides a failure; recovery refuses to start a chat-only runtime
 *    on any reported failure.
 *
 * Restoration is strictly read-only with respect to durable identity: it only
 * reads durable `routa_agent_id` / Routa Session ID values and never uses an
 * ACP/provider session ID as an agent ID, nor writes provider IDs anywhere
 * except `provider_session_id`.
 */

import { getHttpSessionStore, type RoutaSessionRecord } from "@/core/acp/http-session-store";
import { pushAndPersistForwardedNotification } from "@/core/acp/forwarded-notification";
import { buildExecutionBinding } from "@/core/acp/execution-backend";
import { persistSessionToDb } from "@/core/acp/session-db-persister";
import type { TeamBindingFailure } from "@/core/acp/session-recovery-errors";
import { getRoutaSystem } from "@/core/routa-system";
import { AgentRole } from "@/core/models/agent";
import { TaskStatus } from "@/core/models/task";
import type { RoutaOrchestrator } from "@/core/orchestration/orchestrator";
import type {
  ChildAgentRecord,
  TeamRuntimeStateRestore,
} from "@/core/orchestration/team-runtime-state";
import { initRoutaOrchestrator } from "@/core/orchestration/orchestrator-singleton";
import {
  TEAM_LEAD_SPECIALIST_ID,
  collectTeamSessionIds,
} from "@/core/orchestration/team-run-identity";

export type { TeamBindingFailure };

export interface TeamRuntimeRestorationInput {
  /** Durable Routa Session ID being restored. */
  sessionId: string;
  /** Session role; restoration only applies to ROUTA sessions. */
  role?: string;
  workspaceId?: string;
  /** Durable logical Routa agent ID; never a provider session ID. */
  routaAgentId?: string;
  specialistId?: string;
  cwd?: string;
}

export interface TeamRuntimeRestorationResult {
  restored: boolean;
  /**
   * Structured failure whenever a ROUTA restoration could not be completed.
   * NEVER present for non-ROUTA sessions (restoration simply does not apply).
   * Recovery refuses to start a chat-only runtime when this is set — Team
   * binding restoration is all-or-nothing.
   */
  failure?: TeamBindingFailure;
  /**
   * The Team coordination MCP profile, derived during restoration because
   * `mcpProfile` is not durable in the DB schema (specialistId is).
   */
  mcpProfile?: "team-coordination";
  /** Descendant sessions re-registered into the agent↔session map. */
  restoredSessions: number;
  /** Child agent records restored into the orchestrator. */
  restoredChildRecords: number;
}

const NO_RESTORATION: TeamRuntimeRestorationResult = {
  restored: false,
  restoredSessions: 0,
  restoredChildRecords: 0,
};

function bindingFailure(failure: TeamBindingFailure): TeamRuntimeRestorationResult {
  return { ...NO_RESTORATION, failure };
}

function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Install the notification + child-session-registration handlers on the
 * orchestrator. Idempotent: handlers are plain slots, reinstalling replaces
 * the previous installation with the identical behavior.
 */
export function installTeamOrchestrationHandlers(
  orchestrator: RoutaOrchestrator,
  store: ReturnType<typeof getHttpSessionStore>,
): void {
  const handlers = buildTeamOrchestrationHandlers(store);
  orchestrator.setNotificationHandler(handlers.notificationHandler);
  orchestrator.setSessionRegistrationHandler(handlers.sessionRegistrationHandler);
}

function buildTeamOrchestrationHandlers(
  store: ReturnType<typeof getHttpSessionStore>,
): Pick<TeamRuntimeStateRestore, "notificationHandler" | "sessionRegistrationHandler"> {
  const notificationHandler = (targetSessionId: string, data: unknown) => {
    pushAndPersistForwardedNotification(store, targetSessionId, data);
  };

  const sessionRegistrationHandler: TeamRuntimeStateRestore["sessionRegistrationHandler"] = (childSession) => {
    const childExecutionBinding = buildExecutionBinding("embedded");
    store.upsertSession({
      sessionId: childSession.sessionId,
      name: childSession.name,
      cwd: childSession.cwd,
      workspaceId: childSession.workspaceId,
      routaAgentId: childSession.routaAgentId,
      provider: childSession.provider,
      role: childSession.role,
      specialistId: childSession.specialistId,
      parentSessionId: childSession.parentSessionId,
      sandboxId: childSession.sandboxId,
      createdAt: new Date().toISOString(),
      ...childExecutionBinding,
    });
    persistSessionToDb({
      id: childSession.sessionId,
      name: childSession.name,
      cwd: childSession.cwd,
      workspaceId: childSession.workspaceId,
      routaAgentId: childSession.routaAgentId ?? "",
      provider: childSession.provider ?? "",
      role: childSession.role ?? "CRAFTER",
      parentSessionId: childSession.parentSessionId,
      specialistId: childSession.specialistId,
      ...childExecutionBinding,
    }).catch((err: unknown) =>
      console.error(`[TeamRuntime] Failed to persist child session ${childSession.sessionId}:`, err),
    );
  };

  return { notificationHandler, sessionRegistrationHandler };
}

/**
 * Restore the in-memory Team runtime bindings for a durable ROUTA session.
 *
 * ALL-OR-NOTHING (P1): restoration first validates that every required
 * binding CAN be rebuilt, then mutates orchestrator state. If any binding is
 * missing or restoration fails, it returns `{ restored: false, failure }`
 * instead of silently degrading — recovery uses that structured failure to
 * refuse to start a chat-only runtime. The function itself never throws; the
 * recovery caller decides how to surface the failure.
 */
export async function restoreTeamRuntimeBindings(
  input: TeamRuntimeRestorationInput,
): Promise<TeamRuntimeRestorationResult> {
  if (input.role?.toUpperCase() !== "ROUTA") {
    return NO_RESTORATION;
  }

  // A ROUTA Lead must have a durable logical agent ID to rebuild its mapping.
  // Without it the session cannot participate in Team orchestration, so this
  // is reported as missing team metadata rather than a partial restoration.
  const missingMetadata: string[] = [];
  if (!input.routaAgentId) missingMetadata.push("routaAgentId");
  if (missingMetadata.length > 0) {
    return bindingFailure({
      code: "missing_team_metadata",
      message: `Missing team metadata for session ${input.sessionId}: ${missingMetadata.join(", ")}`,
      missingMetadata,
    });
  }

  const orchestrator = initRoutaOrchestrator();
  const store = getHttpSessionStore();

  // Load the durable session tree BEFORE mutating anything, so an incomplete
  // tree fails validation without leaving a partial registration behind.
  let sessions: RoutaSessionRecord[];
  try {
    await store.hydrateFromDb();
    sessions = store.listSessions();
  } catch (err) {
    return bindingFailure({
      code: "team_bindings_incomplete",
      message: `Failed to load the durable session tree for ${input.sessionId}: ${failureMessage(err)}`,
      missingBindings: ["child_session_mappings"],
    });
  }

  const teamSessionIds = new Set(collectTeamSessionIds(input.sessionId, sessions));
  const teamSessions = sessions.filter((session) => teamSessionIds.has(session.sessionId));

  // Every descendant must carry a durable routa_agent_id to be re-mapped.
  const unmappedSessionIds = teamSessions
    .filter((session) => session.sessionId !== input.sessionId)
    .filter((session) => !session.routaAgentId)
    .map((session) => session.sessionId);
  if (unmappedSessionIds.length > 0) {
    return bindingFailure({
      code: "team_bindings_incomplete",
      message:
        `Descendant sessions of ${input.sessionId} lack a durable routa_agent_id ` +
        `and cannot be re-mapped: ${unmappedSessionIds.join(", ")}`,
      missingBindings: ["child_session_mappings"],
      unmappedSessionIds,
    });
  }

  try {
    // Build the complete recovery plan without touching orchestrator state.
    // Only the final restoreTeamRuntimeState call swaps the staged maps and
    // handlers into the live coordinator.
    const handlers = buildTeamOrchestrationHandlers(store);
    const agentSessions = teamSessions.map((session) => ({
      agentId: session.sessionId === input.sessionId
        ? input.routaAgentId as string
        : session.routaAgentId as string,
      sessionId: session.sessionId,
    }));
    if (!agentSessions.some((binding) => binding.sessionId === input.sessionId)) {
      agentSessions.unshift({ agentId: input.routaAgentId as string, sessionId: input.sessionId });
    }
    const childAgents = await buildChildAgentRecords(teamSessions);

    orchestrator.restoreTeamRuntimeState({ ...handlers, agentSessions, childAgents });

    const restoredSessions = agentSessions.filter(
      (binding) => binding.sessionId !== input.sessionId,
    ).length;
    const restoredChildRecords = childAgents.length;

    const mcpProfile = input.specialistId === TEAM_LEAD_SPECIALIST_ID
      ? ("team-coordination" as const)
      : undefined;

    console.log(
      `[TeamRuntime] Restored team bindings for session ${input.sessionId}: ` +
        `${restoredSessions} descendant sessions, ${restoredChildRecords} child records`,
    );

    return { restored: true, mcpProfile, restoredSessions, restoredChildRecords };
  } catch (err) {
    console.warn(
      `[TeamRuntime] Failed to restore team runtime bindings for session ${input.sessionId}:`,
      err,
    );
    return bindingFailure({
      code: "team_bindings_incomplete",
      message: `Failed to restore team runtime bindings for ${input.sessionId}: ${failureMessage(err)}`,
      missingBindings: [
        "notification_handler",
        "child_session_registration_handler",
        "child_session_mappings",
        "child_records",
      ],
    });
  }
}

/**
 * Rebuild ChildAgentRecords for descendant sessions from durable records.
 * The task linkage is resolved through the durable task store (`assignedTo`),
 * because child records themselves are orchestrator-memory only. A child with
 * no resolvable task is still restored with an empty taskId so its
 * agent↔session mapping stays intact; its completion reports simply carry no
 * task context.
 */
async function buildChildAgentRecords(
  teamSessions: RoutaSessionRecord[],
): Promise<ChildAgentRecord[]> {
  const system = getRoutaSystem();
  const sessionById = new Map(teamSessions.map((session) => [session.sessionId, session]));
  const records: ChildAgentRecord[] = [];

  for (const session of teamSessions) {
    if (!session.routaAgentId || !session.parentSessionId) continue;

    const parent = sessionById.get(session.parentSessionId);
    let taskId = "";
    let completionHandled = false;

    try {
      const tasks = await system.taskStore.listByAssignee(session.routaAgentId);
      const workspaceTasks = tasks
        .filter((task) => task.workspaceId === session.workspaceId)
        .sort(
          (a, b) =>
            new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime(),
        );
      const task = workspaceTasks[0];
      if (task) {
        taskId = task.id;
        // A child whose durable task already reached a terminal state must
        // not trigger completion handling again after restoration.
        completionHandled = task.status === TaskStatus.COMPLETED
          || task.status === TaskStatus.CANCELLED;
      }
    } catch (err) {
      console.warn(
        `[TeamRuntime] Could not resolve task for restored child agent ${session.routaAgentId}:`,
        err,
      );
    }

    records.push({
      agentId: session.routaAgentId,
      sessionId: session.sessionId,
      parentAgentId: parent?.routaAgentId ?? "",
      parentSessionId: session.parentSessionId,
      taskId,
      role: (session.role ?? "CRAFTER") as AgentRole,
      provider: session.provider ?? "",
      cwd: session.cwd,
      workspaceId: session.workspaceId,
      completionHandled,
    });
  }

  return records;
}
