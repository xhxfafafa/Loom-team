/**
 * Unified session runtime recovery ("ensureSessionRuntime").
 *
 * Team Run, Agent, Routa Session and history messages are persistent/durable
 * objects; the Provider Runtime (Claude CLI / ACP process / SDK adapter) is an
 * interruptible, replaceable resource. When a user prompt, an explicit
 * session/load (Resume), or a sub-Agent report reaches a Routa Session whose
 * provider runtime is gone, this module restores the runtime from durable
 * metadata.
 *
 * ID separation (invariant — never conflated):
 * - sessionId: Routa Session ID (`acp_sessions.id`), durable.
 * - routaAgentId: durable logical Routa agent ID. Recovery never overwrites
 *   it with a provider/ACP session ID, and it is never sent to a provider as
 *   a session ID.
 * - providerSessionId: provider-native session ID (ACP/Claude/Codex), stored
 *   in `provider_session_id`, used ONLY for native resume.
 *
 * Provider-specific recovery logic lives inside this module (the
 * ProviderRecoveryAdapter surface: `resolveProviderRecoveryStrategy` plus the
 * provider branches in `ensureSessionRuntime`). Callers — Team UI,
 * Orchestrator, API routes — never branch on provider themselves.
 */

import { getHttpSessionStore } from "@/core/acp/http-session-store";
import { getPresetById, type AcpAgentPreset, type ResumeCapability } from "@/core/acp/acp-presets";
import { isServerlessEnvironment } from "@/core/acp/api-based-providers";
import {
  acquireSessionLeaseInDb,
  loadSessionFromDb,
  loadSessionFromLocalStorage,
  persistCapturedProviderSessionId,
  persistSessionToDb,
  tryAcquireSessionLeaseInDb,
  updateSessionRuntimeBindingInDb,
} from "@/core/acp/session-db-persister";
import {
  buildAcpLeaseExpiresAt,
  getAcpInstanceId,
  getEmbeddedOwnershipIssue,
} from "@/core/acp/execution-backend";
import {
  buildRecoveryErrorData,
  buildRecoveryFailedError,
  buildRuntimeOwnedError,
  buildSessionNotFoundError,
  buildTeamBindingsFailedError,
  buildWorkspaceUnavailableError,
  RECOVERY_JSON_RPC_CODES,
  type JsonRpcErrorObject,
} from "@/core/acp/session-recovery-errors";
import { buildProviderModelArgs } from "@/core/acp/provider-model-args";
import {
  collectRecoveryEnvelope,
  renderRecoveryEnvelope,
  setPendingRecoveryContext,
  type RecoveryEnvelope,
} from "@/core/acp/recovery-context";
import { getSpecialistById } from "@/core/orchestration/specialist-prompts";
import { TEAM_LEAD_SPECIALIST_ID } from "@/core/orchestration/team-run-identity";
import type { TeamRuntimeRestorationResult } from "@/core/orchestration/team-runtime-bindings";
import { buildTeamChainPolicyPrompt, type TeamChainId } from "@/core/orchestration/team-chain";
import type { McpServerProfile } from "@/core/mcp/mcp-server-profiles";
import {
  createTraceRecord,
  withWorkspaceId,
  withMetadata,
  recordTrace,
} from "@/core/trace";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * How a provider runtime can be recovered for a persisted Routa Session.
 * - native_resume: provider restores the conversation from its own state
 *   (Codex rollout via session/load, Claude `--resume`/SDK `resume`).
 * - context_rebuild: a fresh provider conversation is started; Routa-side
 *   durable metadata (and history, where the provider supports replay)
 *   carries continuity. The Routa Session ID itself is stable either way.
 * - unavailable: the session cannot be recovered at all (structured error).
 */
export type SessionRecoveryStrategy = "native_resume" | "context_rebuild" | "unavailable";

export interface SessionRecoveryDecision {
  strategy: SessionRecoveryStrategy;
  /** Diagnostic reason for the chosen strategy (never drives client logic). */
  reason?: string;
}

/**
 * Durable session metadata merged from the in-memory store, the DB, or the
 * local JSONL record — whichever is found first. Field names follow the DB
 * row shape (`id`, not `sessionId`).
 */
export interface RecoveredSessionSnapshot {
  id: string;
  name?: string;
  cwd: string;
  branch?: string;
  workspaceId: string;
  routaAgentId?: string;
  providerSessionId?: string;
  provider?: string;
  role?: string;
  toolMode?: "essential" | "full";
  mcpProfile?: McpServerProfile;
  allowedNativeTools?: string[];
  modeId?: string;
  model?: string;
  firstPromptSent?: boolean;
  parentSessionId?: string;
  specialistId?: string;
  specialistSystemPrompt?: string;
  teamChainId?: TeamChainId;
  executionMode?: "embedded" | "runner";
  ownerInstanceId?: string;
  leaseExpiresAt?: string;
  createdAt?: Date | string | null;
}

export interface EnsureSessionRuntimeArgs {
  sessionId: string;
  /** Explicit cwd override that wins over the persisted record (session/load). */
  cwd?: string;
  /** cwd fallback that loses to the persisted record (session/prompt params). */
  cwdFallback?: string;
  /** Provider override from the request (session/prompt `provider` param). */
  providerOverride?: string;
  /** Workspace ID resolved by the caller from request params. */
  workspaceId?: string;
  /** MCP servers requested by the client (session/load `mcpServers`). */
  requestedAcpMcpServers?: Array<Record<string, unknown>>;
  /** Auth JSON for Docker OpenCode containers (session/prompt `authJson`). */
  dockerAuthJson?: string;
  serverUrlOverride?: string;
  /** Allow creating a runtime when no persisted record exists (session/prompt). */
  allowFreshCreate?: boolean;
  /** Record a session_start trace after recovery (session/prompt path). */
  traceSessionStart?: boolean;
  createSessionUpdateForwarder: SessionUpdateForwarderFactory;
  buildMcpConfigForClaude?: ClaudeMcpConfigBuilder;
}

export interface EnsureSessionRuntimeResult {
  status: "attached" | "recovered";
  resumeMode: "attached" | "native" | "recreated";
  /** Recovery strategy used; undefined when the runtime was already attached. */
  strategy?: SessionRecoveryStrategy;
  sessionId: string;
  acpSessionId: string;
  provider: string;
  role: string;
  nativeResumeError?: string;
  /** Present only on the recovery path (not when attaching to a live runtime). */
  resumeCapabilities?: ResumeCapability;
  recoveredSession?: RecoveredSessionSnapshot;
  /**
   * The bounded recovery envelope injected into a rebuilt provider
   * conversation (context_rebuild). Undefined when native resume succeeded
   * or no envelope could be collected.
   */
  recoveryEnvelope?: RecoveryEnvelope;
}

type SessionUpdateForwarderFactory = (
  store: ReturnType<typeof getHttpSessionStore>,
  sessionId: string,
) => (msg: { method?: string; params?: Record<string, unknown> }) => void;

type ClaudeMcpConfigBuilder = (
  workspaceId?: string,
  sessionId?: string,
  toolMode?: "essential" | "full",
  mcpProfile?: McpServerProfile,
) => Promise<string[]>;

/** Structured recovery failure; `jsonRpcError` is the JSON-RPC error envelope. */
export class SessionRuntimeRecoveryError extends Error {
  constructor(public readonly jsonRpcError: JsonRpcErrorObject) {
    super(jsonRpcError.message);
    this.name = "SessionRuntimeRecoveryError";
  }
}

// ─── Record loading ────────────────────────────────────────────────────────

/**
 * Load durable session metadata: in-memory store first, then DB, then local
 * JSONL. Returns undefined when nothing is persisted anywhere.
 */
export async function loadRecoveredSessionSnapshot(
  sessionId: string,
): Promise<RecoveredSessionSnapshot | undefined> {
  const storedSession = getHttpSessionStore().getSession(sessionId);
  if (storedSession) {
    return { ...storedSession, id: sessionId };
  }
  const fromDb = await loadSessionFromDb(sessionId);
  if (fromDb) {
    return { ...fromDb, sessionId: undefined, id: sessionId } as unknown as RecoveredSessionSnapshot;
  }
  const fromLocal = await loadSessionFromLocalStorage(sessionId);
  return fromLocal ?? undefined;
}

// ─── Team Lead prompt rebuild ──────────────────────────────────────────────

/**
 * Rebuild the combined Team Lead prompt (role prompt + chain policy) from
 * persisted session metadata after an in-memory loss (e.g. backend restart).
 * Mirrors the creation-time composition order in acp-session-create.
 */
export function rebuildTeamLeadRecoveryPrompt(teamChainId: TeamChainId | null): string | undefined {
  const specialist = getSpecialistById(TEAM_LEAD_SPECIALIST_ID, "en");

  const specialistSections: string[] = [];
  if (specialist?.systemPrompt?.trim()) {
    specialistSections.push(specialist.systemPrompt.trim());
  }
  if (specialist?.roleReminder) {
    specialistSections.push(`**Reminder:** ${specialist.roleReminder}`);
  }

  const sections = [
    specialistSections.length > 0 ? specialistSections.join("\n\n---\n") : undefined,
    buildTeamChainPolicyPrompt(teamChainId) ?? undefined,
  ].filter((section): section is string => typeof section === "string" && section.trim().length > 0);

  return sections.length > 0 ? sections.join("\n\n---\n\n") : undefined;
}

// ─── ProviderRecoveryAdapter: strategy resolution ──────────────────────────

function isClaudeFamilyProvider(provider: string): boolean {
  return provider === "claude" || provider === "claude-code-sdk";
}

/**
 * A Claude-family `provider_session_id` is only valid when it came from the
 * provider itself (the `system/init` capture hook). A value equal to the
 * Routa Session ID is a pollution artifact — older recovery code persisted
 * the Claude CLI's runtime handle, which IS the Routa Session ID — and must
 * be treated as absent so it can never seed `--resume`/SDK resume or mark a
 * runtime as safely releasable.
 */
export function sanitizeClaudeProviderSessionId(
  providerSessionId: string | undefined,
  routaSessionId: string | undefined,
): string | undefined {
  if (!providerSessionId) return undefined;
  if (routaSessionId && providerSessionId === routaSessionId) return undefined;
  return providerSessionId;
}

/**
 * Decide how a provider runtime is recovered for a persisted session.
 *
 * Rules (mirror the Rust backend's `should_attempt_native_resume` semantics):
 * - Claude family: native resume is possible iff a provider-native session ID
 *   was persisted (seeded into `--resume` / SDK `resume`); otherwise rebuild
 *   context with a fresh provider conversation.
 * - Codex: native resume via session/load requires that at least one prompt
 *   was sent (the rollout file does not exist before the first turn).
 * - Standard ACP presets advertising native/both resume: same first-prompt
 *   gate as Codex.
 * - Everything else (replay-only providers): context rebuild. The Routa
 *   Session ID stays stable; only the provider conversation is new.
 */
export function resolveProviderRecoveryStrategy(
  provider: string,
  preset: AcpAgentPreset | undefined,
  recovered: RecoveredSessionSnapshot | undefined,
): SessionRecoveryDecision {
  if (isClaudeFamilyProvider(provider)) {
    const nativeClaudeSessionId = sanitizeClaudeProviderSessionId(
      recovered?.providerSessionId,
      recovered?.id,
    );
    if (nativeClaudeSessionId) {
      return { strategy: "native_resume", reason: "claude-provider-session-id-persisted" };
    }
    return { strategy: "context_rebuild", reason: "claude-no-provider-session-id" };
  }

  const nativeCapable = provider === "codex"
    || (preset?.resume?.supported === true
      && (preset.resume.mode === "native" || preset.resume.mode === "both"));

  if (nativeCapable) {
    if (recovered?.firstPromptSent) {
      return { strategy: "native_resume", reason: "provider-native-resume" };
    }
    // No provider-side state exists before the first prompt (e.g. Codex has
    // no rollout file yet) — matches Rust `should_attempt_native_resume`.
    return { strategy: "context_rebuild", reason: "native-resume-skipped-before-first-prompt" };
  }

  return { strategy: "context_rebuild", reason: "replay-only-provider" };
}

// ─── Unified recovery entry point ──────────────────────────────────────────

/**
 * In-flight recoveries keyed by Routa Session ID. At most ONE recovery runs
 * per session per instance: concurrent callers (user prompt, explicit Resume,
 * sub-Agent report) join the same recovery promise instead of starting a
 * second Provider Runtime.
 */
const inflightSessionRecoveries = new Map<string, Promise<EnsureSessionRuntimeResult>>();

/**
 * Ensure a provider runtime exists for a persisted Routa Session.
 *
 * This is the single recovery entry point shared by user prompts
 * (session/prompt), explicit Resume (session/load), and sub-Agent reports.
 * It attaches to a live runtime when one exists; otherwise it resolves the
 * provider recovery strategy, performs native resume (with at most ONE
 * bounded context-rebuild fallback when native resume fails), and persists
 * the refreshed runtime binding without touching durable fields.
 *
 * Concurrency: only one recovery runs per Routa Session per instance;
 * simultaneous callers join the in-flight recovery.
 *
 * Throws `SessionRuntimeRecoveryError` carrying a structured JSON-RPC error
 * envelope; callers convert it into their JSON-RPC response unchanged.
 */
export function ensureSessionRuntime(
  args: EnsureSessionRuntimeArgs,
): Promise<EnsureSessionRuntimeResult> {
  const { sessionId } = args;
  const inflight = inflightSessionRecoveries.get(sessionId);
  if (inflight) return inflight;

  const recovery = runEnsureSessionRuntime(args).finally(() => {
    inflightSessionRecoveries.delete(sessionId);
  });
  inflightSessionRecoveries.set(sessionId, recovery);
  return recovery;
}

async function runEnsureSessionRuntime(
  args: EnsureSessionRuntimeArgs,
): Promise<EnsureSessionRuntimeResult> {
  const { getAcpProcessManager } = await import("@/core/acp/processer");
  const manager = getAcpProcessManager();
  const store = getHttpSessionStore();
  const { sessionId } = args;

  const recoveredSession = await loadRecoveredSessionSnapshot(sessionId);

  if (!recoveredSession && !args.allowFreshCreate) {
    throw new SessionRuntimeRecoveryError(buildSessionNotFoundError(sessionId));
  }

  const ownershipIssue = getEmbeddedOwnershipIssue(recoveredSession);
  if (ownershipIssue) {
    const ownedError = buildRuntimeOwnedError(ownershipIssue, recoveredSession);
    throw new SessionRuntimeRecoveryError({
      ...ownedError,
      data: {
        ...ownedError.data,
        source: "app",
        sessionId,
      },
    });
  }

  const defaultProvider = isServerlessEnvironment() ? "claude-code-sdk" : "opencode";
  const provider = args.providerOverride ?? recoveredSession?.provider ?? defaultProvider;
  const cwd = args.cwd ?? recoveredSession?.cwd ?? args.cwdFallback ?? process.cwd();
  const workspaceId = args.workspaceId ?? recoveredSession?.workspaceId;
  const role = recoveredSession?.role ?? "CRAFTER";
  const toolMode = recoveredSession?.toolMode;
  let mcpProfile = recoveredSession?.mcpProfile;
  const allowedNativeTools = recoveredSession?.allowedNativeTools;
  const specialistId = recoveredSession?.specialistId;
  let specialistSystemPrompt = recoveredSession?.specialistSystemPrompt;
  if (!specialistSystemPrompt && specialistId === TEAM_LEAD_SPECIALIST_ID) {
    // The in-memory combined prompt is lost across restarts; rebuild it from
    // persisted metadata (specialistId + teamChainId) so the selected Team
    // Chain policy keeps participating in recovery.
    specialistSystemPrompt = rebuildTeamLeadRecoveryPrompt(recoveredSession?.teamChainId ?? null);
  }

  // ── Team runtime bindings (all-or-nothing, P1) ────────────────────────
  // ROUTA sessions rebuild their orchestration wiring — Lead agent ↔ session
  // mapping, descendant mappings from the durable parent_session_id tree,
  // notification + child-registration handlers, child agent records, Team MCP
  // profile — from durable records. Idempotent; never mutates durable IDs
  // (routa_agent_id, Routa Session IDs, provider_session_id stay untouched).
  // Restoration is ALL-OR-NOTHING: any missing metadata or failed binding is
  // reported as a structured `failure` and enforced below BEFORE a runtime is
  // started — recovery never silently degrades a Team Lead to a chat-only
  // session. The dynamic import keeps the recovery module free of a static
  // orchestration cycle.
  let teamRestoration: TeamRuntimeRestorationResult | undefined;
  if (recoveredSession && role === "ROUTA") {
    const { restoreTeamRuntimeBindings } = await import(
      "@/core/orchestration/team-runtime-bindings"
    );
    teamRestoration = await restoreTeamRuntimeBindings({
      sessionId,
      role,
      workspaceId,
      routaAgentId: recoveredSession.routaAgentId,
      specialistId,
      cwd,
    });
    // mcpProfile is not durable in the DB schema; derive the Team
    // coordination profile from the durable specialistId during restoration.
    mcpProfile = mcpProfile ?? teamRestoration.mcpProfile;
  }
  // Native resume key for standard ACP providers (session/load). The durable
  // routaAgentId is a logical Routa agent identifier and must never be sent
  // to the provider as a session ID; fall back to the Routa session ID as a
  // last-resort load key. Claude-family providers NEVER use this value: their
  // native ID only comes from the persisted `provider_session_id` (captured
  // from the provider's own system/init report).
  const providerSessionId = recoveredSession?.providerSessionId ?? sessionId;
  // The only valid Claude-family resume seed: a provider-native ID previously
  // captured from system/init. Polluted values (== Routa Session ID) are
  // treated as absent.
  const priorNativeClaudeSessionId = isClaudeFamilyProvider(provider)
    ? sanitizeClaudeProviderSessionId(recoveredSession?.providerSessionId, sessionId)
    : undefined;
  const modelArgs = buildProviderModelArgs(provider, recoveredSession?.model);
  const preset = getPresetById(provider);
  const decision = resolveProviderRecoveryStrategy(provider, preset, recoveredSession);

  // ── Attached: the runtime is already alive on this instance. ──
  if (manager.hasActiveSession(sessionId)) {
    // A live local runtime is by definition embedded on this instance; refresh
    // the lease so active sessions keep ownership while they are used.
    const attachedLeaseExpiresAt = buildAcpLeaseExpiresAt();
    const attachedInstanceId = getAcpInstanceId();
    if (recoveredSession) {
      store.upsertSession({
        sessionId,
        name: recoveredSession.name,
        cwd,
        branch: recoveredSession.branch,
        workspaceId: recoveredSession.workspaceId,
        // The logical agent ID is preserved; the provider session ID is
        // tracked separately. For the Claude family the manager's runtime
        // handle is NOT a native ID (it is the Routa Session ID for the CLI,
        // a synthetic handle for the SDK) — keep the native ID captured from
        // the provider's own system/init report instead.
        routaAgentId: recoveredSession.routaAgentId,
        providerSessionId: isClaudeFamilyProvider(provider)
          ? priorNativeClaudeSessionId
          : manager.getAcpSessionId(sessionId) ?? recoveredSession.providerSessionId,
        provider,
        role,
        toolMode,
        mcpProfile,
        allowedNativeTools,
        modeId: recoveredSession.modeId,
        model: recoveredSession.model,
        firstPromptSent: recoveredSession.firstPromptSent,
        parentSessionId: recoveredSession.parentSessionId,
        specialistId,
        specialistSystemPrompt,
        teamChainId: recoveredSession.teamChainId,
        executionMode: "embedded",
        ownerInstanceId: attachedInstanceId,
        leaseExpiresAt: attachedLeaseExpiresAt,
        createdAt: recoveredSession.createdAt instanceof Date
          ? recoveredSession.createdAt.toISOString()
          : (recoveredSession.createdAt ?? new Date().toISOString()),
        acpStatus: "ready",
      });
    }
    // Best-effort CAS refresh: only succeeds while this instance still owns
    // the lease (or no DB row exists yet), never steals from another owner.
    void tryAcquireSessionLeaseInDb(sessionId, {
      ownerInstanceId: attachedInstanceId,
      leaseExpiresAt: attachedLeaseExpiresAt,
      executionMode: "embedded",
    });
    return {
      status: "attached",
      resumeMode: "attached",
      sessionId,
      acpSessionId: manager.getAcpSessionId(sessionId) ?? sessionId,
      provider,
      role,
      recoveredSession,
    };
  }

  if (!workspaceId) {
    throw new SessionRuntimeRecoveryError(
      buildWorkspaceUnavailableError("workspaceId is required to recreate the session"),
    );
  }

  // ── Lease acquisition (compare-and-swap, fail-closed) ────────────────────
  // At most ONE provider runtime per Routa Session, across instances. The
  // acquisition returns a structured 5-state outcome and recovery branches on
  // it explicitly — a bare boolean plus re-read used to collapse "DB outage"
  // into the "JSONL-only, safe to proceed" path and start runtimes during
  // outages:
  // - conflict      → another instance holds the active lease: structured
  //                   retryable error; never start a second Provider Runtime.
  // - unavailable   → ownership could not be verified (DB failure): fail
  //                   CLOSED with a retryable error; no runtime is started
  //                   while ownership is unknown.
  // - missing       → a successful query found no durable row (JSONL-only
  //                   session): explicitly determined, safe to proceed.
  // - acquired / already_owned → proceed.
  const ownerInstanceId = getAcpInstanceId();
  const leaseExpiresAt = buildAcpLeaseExpiresAt();
  if (recoveredSession) {
    const leaseAcquisition = await acquireSessionLeaseInDb(sessionId, {
      ownerInstanceId,
      leaseExpiresAt,
      executionMode: "embedded",
    });
    if (leaseAcquisition.outcome === "conflict") {
      const currentOwner = leaseAcquisition.ownerInstanceId?.trim() || "another instance";
      const ownedError = buildRuntimeOwnedError(
        `Session is currently owned by instance ${currentOwner}` +
          (leaseAcquisition.leaseExpiresAt ? ` until ${leaseAcquisition.leaseExpiresAt}` : "") + ".",
        {
          executionMode: "embedded",
          ownerInstanceId: leaseAcquisition.ownerInstanceId,
          leaseExpiresAt: leaseAcquisition.leaseExpiresAt,
        },
      );
      throw new SessionRuntimeRecoveryError({
        ...ownedError,
        data: {
          ...ownedError.data,
          source: "app",
          sessionId,
        },
      });
    }
    if (leaseAcquisition.outcome === "unavailable") {
      throw new SessionRuntimeRecoveryError({
        code: RECOVERY_JSON_RPC_CODES.recoveryUnavailable,
        message:
          `Session runtime lease for ${sessionId} could not be verified because the session database is unavailable. ` +
          "No runtime was started; retry once the database recovers.",
        data: buildRecoveryErrorData("recovery_unavailable", {
          retryable: true,
          sessionId,
          source: "app",
        }),
      });
    }
  }

  // ── Team bindings: all-or-nothing (P1) ──────────────────────────────────
  // A ROUTA runtime must never start chat-only. If the coordination bindings
  // could not be fully restored from durable state, fail recovery with a
  // structured error BEFORE starting any runtime — the Team UI keeps history
  // and input and shows the localized failure. Attached runtimes never reach
  // this point: their bindings were installed when the live runtime was
  // created in this process, so a failed refresh cannot take them down.
  if (teamRestoration && !teamRestoration.restored) {
    const bindingsError = buildTeamBindingsFailedError(sessionId, teamRestoration.failure);
    throw new SessionRuntimeRecoveryError({
      ...bindingsError,
      data: { ...bindingsError.data, source: "app" },
    });
  }

  const forwardSessionUpdate = args.createSessionUpdateForwarder(store, sessionId);
  // When the provider reports a (new) native session ID — e.g. the Claude
  // system/init message after a seeded --resume — persist it as the runtime
  // binding. It never feeds back into routaAgentId. Delegates to the shared
  // persister helper, which rejects runtime handles / Routa Session IDs.
  const recordCapturedRecoveryProviderSessionId = (capturedProviderSessionId: string) => {
    store.setProviderSessionId(sessionId, capturedProviderSessionId);
    void persistCapturedProviderSessionId(sessionId, capturedProviderSessionId);
  };

  const sessionContext = { provider, role };

  const createClaudeRuntime = async (
    resumeSeed?: string,
    appendSystemPrompt?: string,
  ): Promise<string> => {
    if (provider === "claude-code-sdk") {
      const { isClaudeCodeSdkConfigured } = await import("@/core/acp/claude-code-sdk-adapter");
      if (!isClaudeCodeSdkConfigured()) {
        throw new SessionRuntimeRecoveryError({
          code: -32002,
          message: "Cannot auto-create session: Claude Code SDK not configured. Set ANTHROPIC_AUTH_TOKEN environment variable.",
          data: buildRecoveryErrorData("provider_configuration_missing", { provider }),
        });
      }
      // The rebuild envelope is appended after the specialist prompt; native
      // resume never receives one.
      const systemPromptAppend = [specialistSystemPrompt, appendSystemPrompt]
        .filter((section): section is string => Boolean(section))
        .join("\n\n") || undefined;
      return manager.createClaudeCodeSdkSession(
        sessionId,
        cwd,
        forwardSessionUpdate,
        {
          provider: "claude-code-sdk",
          role,
          specialistId,
          model: recoveredSession?.model,
          allowedNativeTools,
          systemPromptAppend,
          sdkSessionId: resumeSeed,
        },
        undefined,
        recordCapturedRecoveryProviderSessionId,
      );
    }
    const mcpConfigs = args.buildMcpConfigForClaude
      ? await args.buildMcpConfigForClaude(workspaceId, sessionId, toolMode, mcpProfile)
      : undefined;
    return manager.createClaudeSession(
      sessionId,
      cwd,
      forwardSessionUpdate,
      mcpConfigs,
      undefined,
      role,
      undefined,
      allowedNativeTools,
      resumeSeed,
      recordCapturedRecoveryProviderSessionId,
      appendSystemPrompt,
    );
  };

  // ── Bounded context rebuild envelope ─────────────────────────────────────
  // A rebuilt provider conversation has no memory of the interrupted work.
  // Collect ONE bounded envelope from durable Routa state and inject it
  // exactly once: via the system-prompt append channel for the Claude family
  // (`--append-system-prompt` / SDK `systemPromptAppend`), via a one-shot
  // pending prompt prefix for providers without such a channel. Never
  // injected when native resume succeeds. Collection is best-effort: a
  // failure degrades to recovery without an envelope.
  let recoveryEnvelope: RecoveryEnvelope | undefined;
  let recoveryEnvelopeCollected = false;
  const collectEnvelopeOnce = async (): Promise<RecoveryEnvelope | undefined> => {
    if (!recoveryEnvelopeCollected) {
      recoveryEnvelopeCollected = true;
      try {
        recoveryEnvelope = (await collectRecoveryEnvelope({
          sessionId,
          provider,
          role,
          cwd,
          branch: recoveredSession?.branch,
          workspaceId,
          specialistId,
          specialistSystemPrompt,
        })) ?? undefined;
      } catch (envelopeError) {
        console.warn(
          `[SessionRecovery] Recovery envelope collection failed for ${sessionId}:`,
          envelopeError,
        );
        recoveryEnvelope = undefined;
      }
    }
    return recoveryEnvelope;
  };

  let acpSessionId: string;
  let resumeMode: "native" | "recreated" = "recreated";
  let nativeResumeError: string | undefined;
  let strategy: SessionRecoveryStrategy = decision.strategy;

  try {
    if (isClaudeFamilyProvider(provider)) {
      // Claude native resume seeds the provider with the persisted
      // provider-native session ID (sanitized — never the Routa Session ID);
      // context rebuild starts unseeded and injects the recovery envelope.
      const resumeSeed = decision.strategy === "native_resume"
        ? priorNativeClaudeSessionId
        : undefined;
      try {
        if (resumeSeed) {
          // Native resume keeps the provider's own conversation context:
          // nothing is collected or injected.
          acpSessionId = await createClaudeRuntime(resumeSeed);
          resumeMode = "native";
        } else {
          const rebuildEnvelope = await collectEnvelopeOnce();
          acpSessionId = await createClaudeRuntime(
            undefined,
            rebuildEnvelope ? renderRecoveryEnvelope(rebuildEnvelope) : undefined,
          );
          resumeMode = "recreated";
        }
      } catch (resumeError) {
        if (resumeError instanceof SessionRuntimeRecoveryError || !resumeSeed) {
          throw resumeError;
        }
        // Bounded fallback: exactly one context rebuild when native resume
        // fails (e.g. the provider-side session file is gone). The envelope
        // is collected once and injected only into this rebuild attempt.
        nativeResumeError = resumeError instanceof Error ? resumeError.message : "Native resume failed";
        console.warn(`[SessionRecovery] Claude native resume failed for ${sessionId}, rebuilding context:`, resumeError);
        strategy = "context_rebuild";
        const rebuildEnvelope = await collectEnvelopeOnce();
        acpSessionId = await createClaudeRuntime(
          undefined,
          rebuildEnvelope ? renderRecoveryEnvelope(rebuildEnvelope) : undefined,
        );
      }
    } else if (decision.strategy === "native_resume") {
      try {
        acpSessionId = await manager.loadSession(
          sessionId,
          cwd,
          forwardSessionUpdate,
          provider,
          workspaceId,
          toolMode,
          mcpProfile,
          args.serverUrlOverride,
          sessionContext,
          providerSessionId,
          args.requestedAcpMcpServers,
          modelArgs,
        );
        resumeMode = "native";
      } catch (resumeError) {
        // Bounded fallback: exactly one context rebuild when native resume
        // fails (e.g. the provider rollout/session is gone).
        nativeResumeError = resumeError instanceof Error ? resumeError.message : "Native resume failed";
        console.warn(`[SessionRecovery] Native resume failed for ${sessionId} (provider: ${provider}), rebuilding context:`, resumeError);
        strategy = "context_rebuild";
        acpSessionId = await manager.createSession(
          sessionId,
          cwd,
          forwardSessionUpdate,
          provider,
          recoveredSession?.modeId,
          modelArgs,
          undefined,
          workspaceId,
          toolMode,
          mcpProfile,
          args.serverUrlOverride,
          sessionContext,
          args.requestedAcpMcpServers,
        );
      }
    } else if (provider === "opencode-sdk") {
      const { isOpencodeServerConfigured } = await import("@/core/acp/opencode-sdk-adapter");
      if (!isOpencodeServerConfigured()) {
        throw new SessionRuntimeRecoveryError({
          code: -32002,
          message: "Cannot auto-create session: OpenCode SDK not configured. Set OPENCODE_SERVER_URL environment variable.",
          data: buildRecoveryErrorData("provider_configuration_missing", { provider }),
        });
      }
      acpSessionId = await manager.createOpencodeSdkSession(sessionId, forwardSessionUpdate);
    } else if (provider === "docker-opencode") {
      const { getDockerDetector } = await import("@/core/acp/docker/detector");
      const dockerStatus = await getDockerDetector().checkAvailability();
      if (!dockerStatus.available) {
        throw new SessionRuntimeRecoveryError({
          code: -32003,
          message: dockerStatus.error
            ? `Cannot auto-create Docker session: ${dockerStatus.error}`
            : "Cannot auto-create Docker session: Docker daemon unavailable.",
          data: buildRecoveryErrorData("provider_configuration_missing", { provider }),
        });
      }
      const { DEFAULT_DOCKER_AGENT_IMAGE } = await import("@/core/acp/docker/utils");
      acpSessionId = await manager.createDockerSession(
        sessionId,
        cwd,
        forwardSessionUpdate,
        process.env.ROUTA_DOCKER_OPENCODE_IMAGE ?? DEFAULT_DOCKER_AGENT_IMAGE,
        undefined,
        args.dockerAuthJson,
      );
    } else {
      acpSessionId = await manager.createSession(
        sessionId,
        cwd,
        forwardSessionUpdate,
        provider,
        recoveredSession?.modeId,
        modelArgs,
        undefined,
        workspaceId,
        toolMode,
        mcpProfile,
        args.serverUrlOverride,
        sessionContext,
        args.requestedAcpMcpServers,
      );
    }
  } catch (err) {
    if (err instanceof SessionRuntimeRecoveryError) {
      throw err;
    }
    console.error("[SessionRecovery] Failed to recover session runtime:", err);
    throw new SessionRuntimeRecoveryError(buildRecoveryFailedFromError(err));
  }

  // Providers without a system-prompt append channel receive the rebuild
  // envelope as a one-shot prefix on the next dispatched prompt (consumed
  // exactly once in session-prompt; never recorded in durable history).
  // Claude family rebuilds were already injected at runtime creation.
  if (resumeMode === "recreated" && !isClaudeFamilyProvider(provider)) {
    const rebuildEnvelope = await collectEnvelopeOnce();
    if (rebuildEnvelope) {
      setPendingRecoveryContext(sessionId, renderRecoveryEnvelope(rebuildEnvelope));
    }
  }

  // ── Recovery writes: refresh the runtime binding, preserve durable IDs. ──
  const now = new Date();
  const recoveredCreatedAt = recoveredSession?.createdAt instanceof Date
    ? recoveredSession.createdAt.toISOString()
    : recoveredSession?.createdAt;
  // Which value may be persisted as `provider_session_id`?
  // - Claude family: the create-call return value is a runtime handle (the
  //   Routa Session ID for the CLI, a synthetic adapter handle for the SDK),
  //   NEVER a provider-native resume ID. The only legitimate source of a
  //   Claude native ID is the system/init capture hook
  //   (`persistCapturedProviderSessionId`). A successful native resume keeps
  //   the previously persisted native ID until the provider reports a new
  //   one; a context rebuild clears any stale/polluted value (`null`) and
  //   stays empty until the provider reports its native ID.
  // - Standard ACP providers: the ID returned by session/new or session/load
  //   IS the real provider session ID and may be persisted as-is.
  const recoveredProviderSessionId: string | null | undefined = isClaudeFamilyProvider(provider)
    ? (resumeMode === "native" ? priorNativeClaudeSessionId : null)
    : acpSessionId;
  const sessionRecord = {
    sessionId,
    // Durable metadata is carried across recovery instead of being reset.
    name: recoveredSession?.name,
    cwd,
    branch: recoveredSession?.branch,
    workspaceId,
    // The logical Routa agent ID survives recovery unchanged; the provider
    // session ID is tracked separately and must never replace it.
    routaAgentId: recoveredSession?.routaAgentId,
    providerSessionId: recoveredProviderSessionId ?? undefined,
    provider,
    role,
    toolMode,
    mcpProfile,
    allowedNativeTools,
    modeId: recoveredSession?.modeId,
    model: recoveredSession?.model,
    firstPromptSent: recoveredSession?.firstPromptSent,
    parentSessionId: recoveredSession?.parentSessionId,
    specialistId,
    specialistSystemPrompt,
    teamChainId: recoveredSession?.teamChainId,
    createdAt: recoveredCreatedAt ?? now.toISOString(),
    acpStatus: "ready" as const,
    // The lease acquired via CAS above (never recomputed read-then-save).
    executionMode: "embedded" as const,
    ownerInstanceId,
    leaseExpiresAt,
  };
  store.upsertSession(sessionRecord);

  // Persist the runtime binding with a targeted update so durable fields
  // (history, firstPromptSent, routa_agent_id, team metadata) are never
  // erased by recovery. When no DB row exists yet (JSONL-only recovery or
  // first persistence), write a complete record instead.
  try {
    const runtimeBindingUpdated = await updateSessionRuntimeBindingInDb(sessionId, {
      // `null` explicitly clears a stale/polluted native ID after a Claude
      // context rebuild; `undefined` leaves the column untouched.
      providerSessionId: recoveredProviderSessionId,
      executionMode: sessionRecord.executionMode,
      ownerInstanceId: sessionRecord.ownerInstanceId,
      leaseExpiresAt: sessionRecord.leaseExpiresAt,
    });
    if (!runtimeBindingUpdated) {
      await persistSessionToDb({
        id: sessionId,
        name: recoveredSession?.name,
        cwd,
        branch: recoveredSession?.branch,
        workspaceId,
        routaAgentId: recoveredSession?.routaAgentId,
        providerSessionId: recoveredProviderSessionId ?? undefined,
        provider,
        role,
        modeId: recoveredSession?.modeId,
        model: recoveredSession?.model,
        firstPromptSent: recoveredSession?.firstPromptSent,
        parentSessionId: recoveredSession?.parentSessionId,
        specialistId: specialistId ?? undefined,
        teamChainId: recoveredSession?.teamChainId ?? undefined,
        executionMode: sessionRecord.executionMode,
        ownerInstanceId: sessionRecord.ownerInstanceId,
        leaseExpiresAt: sessionRecord.leaseExpiresAt,
        createdAt: recoveredSession?.createdAt instanceof Date
          ? recoveredSession.createdAt
          : undefined,
      });
    }
  } catch (persistError) {
    // Persistence failures must not fail the recovered runtime; the in-memory
    // binding is live and will be retried on the next recovery/persist cycle.
    console.warn(`[SessionRecovery] Failed to persist runtime binding for ${sessionId}:`, persistError);
  }

  if (args.traceSessionStart) {
    const sessionStartTrace = withMetadata(
      withMetadata(
        withWorkspaceId(
          createTraceRecord(sessionId, "session_start", { provider }),
          workspaceId,
        ),
        "cwd",
        cwd,
      ),
      "role",
      role,
    );
    recordTrace(cwd, sessionStartTrace);
  }

  console.log(`[SessionRecovery] Recovered session runtime: ${sessionId} (provider: ${provider}, resumeMode: ${resumeMode}, agent session: ${acpSessionId})`);

  return {
    status: "recovered",
    resumeMode,
    strategy,
    sessionId,
    acpSessionId,
    provider,
    role,
    nativeResumeError,
    resumeCapabilities: preset?.resume ?? { supported: false, mode: "replay" },
    recoveredSession,
    recoveryEnvelope,
  };
}

function buildRecoveryFailedFromError(err: unknown): JsonRpcErrorObject {
  return buildRecoveryFailedError(
    `Failed to recover session runtime: ${err instanceof Error ? err.message : "Unknown error"}`,
  );
}
