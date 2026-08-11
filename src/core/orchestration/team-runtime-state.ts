import type { AgentRole } from "@/core/models/agent";

/** Runtime-only child coordination record reconstructed from durable state. */
export interface ChildAgentRecord {
  agentId: string;
  sessionId: string;
  parentAgentId: string;
  parentSessionId: string;
  taskId: string;
  role: AgentRole;
  provider: string;
  cwd: string;
  workspaceId: string;
  completionHandled?: boolean;
  delegationToolCallId?: string;
}

export interface TeamSessionRegistration {
  sessionId: string;
  name?: string;
  cwd: string;
  workspaceId: string;
  routaAgentId: string;
  provider: string;
  role: string;
  specialistId?: string;
  parentSessionId?: string;
  sandboxId?: string;
}

export interface TeamRuntimeStateRestore {
  agentSessions: Array<{ agentId: string; sessionId: string }>;
  childAgents: ChildAgentRecord[];
  notificationHandler: (sessionId: string, data: unknown) => void;
  sessionRegistrationHandler: (session: TeamSessionRegistration) => void;
}
