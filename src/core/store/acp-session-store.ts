/**
 * AcpSessionStore - Interface for persisting ACP chat sessions.
 * 
 * Stores session metadata and message history for:
 * - Session switching with history preservation
 * - Rename and delete operations
 * - Persistent storage across restarts
 */

import type { TeamChainId } from "../orchestration/team-chain";

export interface AcpSessionNotification {
  sessionId: string;
  update?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Structured outcome of an idempotent history append (`appendHistoryOnce`).
 *
 * A bare boolean cannot distinguish "already delivered" from "session row
 * missing", and callers were misreading both as duplicates. Storage-layer
 * failures are NOT a status: they throw, so a lost write can never be
 * mistaken for an acknowledgement.
 */
export type AppendHistoryOnceStatus = "appended" | "duplicate" | "session_not_found";

export interface AcpSession {
  id: string;
  /** User-editable display name */
  name?: string;
  cwd: string;
  /** Git branch the session is scoped to (optional) */
  branch?: string;
  workspaceId: string;
  /**
   * Durable Routa logical agent ID. Recovery must preserve this value;
   * provider/ACP session IDs are stored in `providerSessionId` instead.
   */
  routaAgentId?: string;
  /**
   * Provider-native session ID (ACP/Claude/Codex). Only used to resume the
   * provider session; never substituted for `routaAgentId`.
   */
  providerSessionId?: string;
  provider?: string;
  role?: string;
  modeId?: string;
  /** Model used for this session */
  model?: string;
  firstPromptSent?: boolean;
  messageHistory: AcpSessionNotification[];
  createdAt: Date;
  updatedAt: Date;
  /** Parent session ID for child (CRAFTER/GATE) sessions */
  parentSessionId?: string;
  /** Specialist ID used to configure this session, if any. */
  specialistId?: string;
  /**
   * Team execution chain selected for a top-level team-agent-lead session.
   * Omitted/NULL means legacy Full Delivery.
   */
  teamChainId?: TeamChainId;
  executionMode?: "embedded" | "runner";
  ownerInstanceId?: string;
  leaseExpiresAt?: string;
}

export interface AcpSessionStore {
  /** Create or update a session */
  save(session: AcpSession): Promise<void>;
  
  /** Get a session by ID */
  get(sessionId: string): Promise<AcpSession | undefined>;
  
  /** List all sessions, sorted by most recent first */
  list(): Promise<AcpSession[]>;
  
  /** Delete a session */
  delete(sessionId: string): Promise<void>;
  
  /** Rename a session */
  rename(sessionId: string, name: string): Promise<void>;
  
  /** Append a notification to message history */
  appendHistory(sessionId: string, notification: AcpSessionNotification): Promise<void>;

  /**
   * Idempotent, atomic append to message history keyed by event ID.
   *
   * Appends the notification (stamped with the given event ID) exactly once:
   * the existence check and the append happen inside one operation/transaction,
   * so concurrent retries cannot both append. Returns a STRUCTURED status —
   * `"appended"` when newly recorded, `"duplicate"` when the event ID already
   * exists, `"session_not_found"` when the session row is missing — so callers
   * never confuse a missing session (or a failed write, which THROWS) with a
   * duplicate delivery. This is the durable acknowledgement used for prompt
   * and child-report delivery retries; durable fields are otherwise untouched.
   */
  appendHistoryOnce(
    sessionId: string,
    eventId: string,
    notification: AcpSessionNotification,
  ): Promise<AppendHistoryOnceStatus>;

  /** Whether an event with the given ID exists in the session's history. */
  hasHistoryEvent(sessionId: string, eventId: string): Promise<boolean>;

  /** Get message history for a session */
  getHistory(
    sessionId: string,
    options?: { afterEventId?: string },
  ): Promise<AcpSessionNotification[]>;
  
  /** Mark first prompt as sent */
  markFirstPromptSent(sessionId: string): Promise<void>;

  /** Update session mode */
  updateMode(sessionId: string, modeId: string): Promise<void>;

  /**
   * Update only the provider-native session ID, leaving every durable field
   * (routaAgentId, history, firstPromptSent, metadata) untouched.
   */
  setProviderSessionId(sessionId: string, providerSessionId: string | undefined): Promise<void>;

  /**
   * Targeted runtime-binding update used by recovery: sets the provider
   * session ID and/or execution binding without touching durable fields
   * (history, firstPromptSent, routaAgentId, metadata).
   * Returns true when a row was updated, false when the session is unknown.
   */
  updateRuntimeBinding(
    sessionId: string,
    update: {
      providerSessionId?: string;
      executionMode?: "embedded" | "runner";
      ownerInstanceId?: string;
      leaseExpiresAt?: string;
    },
  ): Promise<boolean>;

  /**
   * Atomically acquire (or refresh) the runtime lease for a session.
   *
   * Succeeds only when the row has no owner, no lease, an expired lease, or
   * is already owned by the requesting instance (a refresh). Implemented as a
   * single conditional UPDATE (compare-and-swap) — never read-then-save — so
   * concurrent instances cannot both acquire the same session. Durable fields
   * (routa_agent_id, history, provider_session_id, metadata) are untouched.
   *
   * Returns true when the lease was acquired or refreshed; false when another
   * instance holds an active lease (or the session row does not exist). The
   * caller must re-read the session on failure to decide between joining
   * (same instance) and returning a structured retryable conflict.
   */
  tryAcquireExpiredLease(
    sessionId: string,
    acquire: {
      ownerInstanceId: string;
      leaseExpiresAt: string;
      executionMode?: "embedded" | "runner";
    },
    now?: Date,
  ): Promise<boolean>;
}

/**
 * In-memory implementation for development/testing
 */
export class InMemoryAcpSessionStore implements AcpSessionStore {
  private sessions = new Map<string, AcpSession>();

  async save(session: AcpSession): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async get(sessionId: string): Promise<AcpSession | undefined> {
    return this.sessions.get(sessionId);
  }

  async list(): Promise<AcpSession[]> {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async rename(sessionId: string, name: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.name = name;
      session.updatedAt = new Date();
    }
  }

  async appendHistory(sessionId: string, notification: AcpSessionNotification): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messageHistory.push(notification);
      session.updatedAt = new Date();
    }
  }

  async appendHistoryOnce(
    sessionId: string,
    eventId: string,
    notification: AcpSessionNotification,
  ): Promise<AppendHistoryOnceStatus> {
    const session = this.sessions.get(sessionId);
    if (!session) return "session_not_found";
    if (session.messageHistory.some((entry) => entry.eventId === eventId)) {
      return "duplicate";
    }
    session.messageHistory.push({ ...notification, eventId });
    session.updatedAt = new Date();
    return "appended";
  }

  async hasHistoryEvent(sessionId: string, eventId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.messageHistory.some((entry) => entry.eventId === eventId);
  }

  async getHistory(
    sessionId: string,
    options?: { afterEventId?: string },
  ): Promise<AcpSessionNotification[]> {
    const history = this.sessions.get(sessionId)?.messageHistory ?? [];
    const afterEventId = options?.afterEventId;
    if (!afterEventId) return history;
    const index = history.findIndex((entry) => entry.eventId === afterEventId);
    return index >= 0 ? history.slice(index + 1) : [];
  }

  async markFirstPromptSent(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.firstPromptSent = true;
      session.updatedAt = new Date();
    }
  }

  async updateMode(sessionId: string, modeId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.modeId = modeId;
      session.updatedAt = new Date();
    }
  }

  async setProviderSessionId(sessionId: string, providerSessionId: string | undefined): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.providerSessionId = providerSessionId;
      session.updatedAt = new Date();
    }
  }

  async updateRuntimeBinding(
    sessionId: string,
    update: {
      providerSessionId?: string;
      executionMode?: "embedded" | "runner";
      ownerInstanceId?: string;
      leaseExpiresAt?: string;
    },
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (update.providerSessionId !== undefined) session.providerSessionId = update.providerSessionId;
    if (update.executionMode !== undefined) session.executionMode = update.executionMode;
    if (update.ownerInstanceId !== undefined) session.ownerInstanceId = update.ownerInstanceId;
    if (update.leaseExpiresAt !== undefined) session.leaseExpiresAt = update.leaseExpiresAt;
    session.updatedAt = new Date();
    return true;
  }

  async tryAcquireExpiredLease(
    sessionId: string,
    acquire: {
      ownerInstanceId: string;
      leaseExpiresAt: string;
      executionMode?: "embedded" | "runner";
    },
    now: Date = new Date(),
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Mirrors the SQL CAS predicate: acquire only when unowned, leaseless,
    // expired, or already owned by the requesting instance.
    const leaseExpiresAtMs = session.leaseExpiresAt ? Date.parse(session.leaseExpiresAt) : Number.NaN;
    const leaseActive = Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs > now.getTime();
    const ownedByOtherInstance = !!session.ownerInstanceId && session.ownerInstanceId !== acquire.ownerInstanceId;
    if (leaseActive && ownedByOtherInstance) return false;

    session.ownerInstanceId = acquire.ownerInstanceId;
    session.leaseExpiresAt = acquire.leaseExpiresAt;
    if (acquire.executionMode !== undefined) session.executionMode = acquire.executionMode;
    session.updatedAt = new Date();
    return true;
  }
}
