import { AgentEventBridge, type WorkspaceAgentEvent } from "../acp/agent-event-bridge";
import type { AcpProcessManager } from "../acp/acp-process-manager";
import { LifecycleNotifier } from "../acp/lifecycle-notifier";
import { persistCapturedProviderSessionId } from "../acp/session-db-persister";
import type { NotificationHandler } from "../acp/protocol-types";
import { getProviderAdapter } from "../acp/provider-adapter";
import type { RoutaSystem } from "../routa-system";
import { createWorkspaceSessionSandbox } from "../sandbox/permissions";

function isWorkspaceProvider(provider: string): boolean {
  return provider === "workspace" || provider === "workspace-agent" || provider === "routa-native";
}

export async function createDelegatedChildSession(input: {
  sessionId: string;
  agentId: string;
  provider: string;
  cwd: string;
  parentSessionId: string;
  workspaceId?: string;
  system: RoutaSystem;
  processManager: AcpProcessManager;
  serverPort: string | number;
  notificationSink?: (sessionId: string, params: Record<string, unknown>) => void;
  onCompletionUpdate: (agentId: string, params: Record<string, unknown>) => void;
  onAgentEvent: (agentId: string, event: WorkspaceAgentEvent) => void;
  watchForReports: (agentId: string, cwd: string) => void;
}): Promise<{ sandboxId?: string; acpSessionId: string; bridge: AgentEventBridge }> {
  const {
    sessionId, agentId, provider, cwd, parentSessionId, workspaceId,
    system, processManager, serverPort, notificationSink,
  } = input;
  const bridge = new AgentEventBridge(sessionId);
  const agent = await system.agentStore.get(agentId);
  const effectiveWorkspaceId = workspaceId ?? agent?.workspaceId;
  if (!effectiveWorkspaceId) {
    throw new Error(`workspaceId is required to spawn child agent ${agentId}`);
  }
  const lifecycleNotifier = new LifecycleNotifier(
    system.eventBus,
    system.agentStore,
    system.conversationStore,
    { agentId, workspaceId: effectiveWorkspaceId, parentId: agent?.parentId, agentName: agent?.name },
  );
  const notificationHandler: NotificationHandler = (message) => {
    if (message.method !== "session/update" || !message.params) return;
    const params = message.params as Record<string, unknown>;
    input.onCompletionUpdate(agentId, params);
    const normalized = getProviderAdapter(provider).normalize(sessionId, params);
    for (const update of normalized ? (Array.isArray(normalized) ? normalized : [normalized]) : []) {
      for (const event of bridge.process(update)) input.onAgentEvent(agentId, event);
    }
    notificationSink?.(sessionId, { ...params, sessionId });
    notificationSink?.(parentSessionId, {
      ...params,
      sessionId: parentSessionId,
      childAgentId: agentId,
      childSessionId: sessionId,
    });
  };

  const mcpUrl = new URL(`http://${process.env.HOST ?? "localhost"}:${serverPort}/api/mcp`);
  mcpUrl.searchParams.set("wsId", effectiveWorkspaceId);
  mcpUrl.searchParams.set("sid", parentSessionId);

  let sandboxId: string | undefined;
  let acpSessionId: string;
  if (isWorkspaceProvider(provider)) {
    sandboxId = (await createWorkspaceSessionSandbox({
      workspaceId: effectiveWorkspaceId,
      workdir: cwd,
    }))?.id;
    acpSessionId = await processManager.createWorkspaceAgentSession(
      sessionId,
      cwd,
      notificationHandler,
      { agentTools: system.tools, workspaceId: effectiveWorkspaceId, agentId, sandboxId, lifecycleNotifier },
    );
  } else if (provider === "claude") {
    const config = JSON.stringify({ mcpServers: { routa: { url: mcpUrl.toString(), type: "http" } } });
    acpSessionId = await processManager.createClaudeSession(
      sessionId, cwd, notificationHandler, [config],
      undefined, undefined, undefined, undefined, undefined,
      (captured) => void persistCapturedProviderSessionId(sessionId, captured),
    );
    input.watchForReports(agentId, cwd);
  } else if (provider === "claude-code-sdk") {
    acpSessionId = await processManager.createClaudeCodeSdkSession(
      sessionId,
      cwd,
      notificationHandler,
      { provider: "claude-code-sdk" },
      lifecycleNotifier,
      (captured) => void persistCapturedProviderSessionId(sessionId, captured),
    );
  } else {
    acpSessionId = await processManager.createSession(
      sessionId, cwd, notificationHandler, provider,
      undefined, undefined, undefined, workspaceId,
    );
  }
  return { sandboxId, acpSessionId, bridge };
}

export async function dispatchDelegatedChildPrompt(input: {
  agentId: string;
  sessionId: string;
  acpSessionId: string;
  provider: string;
  prompt: string;
  processManager: AcpProcessManager;
  onComplete: (agentId: string) => void;
  onError: (agentId: string, error: unknown) => void;
}): Promise<void> {
  const { agentId, sessionId, acpSessionId, provider, prompt, processManager } = input;
  const consume = async (stream: AsyncIterable<unknown>) => {
    try {
      for await (const _ of stream) void _;
      input.onComplete(agentId);
    } catch (error) {
      input.onError(agentId, error);
    }
  };

  if (isWorkspaceProvider(provider)) {
    const adapter = processManager.getWorkspaceAgent(sessionId);
    if (!adapter) throw new Error(`Workspace agent process for session ${sessionId} is not available`);
    void consume(adapter.promptStream(prompt, acpSessionId));
    return;
  }
  if (provider === "claude-code-sdk") {
    const adapter = processManager.getClaudeCodeSdkAdapter(sessionId);
    if (!adapter) throw new Error(`Claude Code SDK adapter for session ${sessionId} is not available`);
    void consume(adapter.promptStream(prompt, acpSessionId));
    return;
  }

  const process = provider === "claude"
    ? processManager.getClaudeProcess(sessionId)
    : processManager.getProcess(sessionId);
  if (!process) {
    const label = provider === "claude" ? "Claude" : "ACP";
    throw new Error(`${label} process for session ${sessionId} is not available`);
  }
  void process.prompt(acpSessionId, prompt)
    .then(() => input.onComplete(agentId))
    .catch((error) => input.onError(agentId, error));
}
