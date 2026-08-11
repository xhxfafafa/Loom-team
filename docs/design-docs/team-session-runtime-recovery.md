---
title: Team Session Runtime Lifecycle and Recovery
status: proposed
purpose: Define a small, provider-aware recovery path for Team sessions without keeping every Agent process online.
---

# Team Session Runtime Lifecycle and Recovery

## Decision summary

A Team Run, its Agents, and their Routa Sessions are durable product objects. Claude, Codex,
OpenCode, and other provider processes are replaceable runtimes and do not need to stay online for
the lifetime of the Team.

When a provider runtime exits, Routa keeps the same Team, Agent ID, Routa Session ID, transcript,
and task relationships. On the next message or child report, Routa recovers a runtime through the
session's provider adapter and appends new events to the same Routa Session.

The first implementation should reuse `acp_sessions` and the existing provider adapters. It does
not introduce a new scheduler, event-sourcing system, or session-lineage table.

## Problem

The current web runtime mixes two lifecycles:

- durable state: Team metadata, Agent identity, Session metadata, transcript, tasks, and child links
- transient state: Node.js objects, provider processes, SSE controllers, MCP connections, and
  in-memory orchestration maps

An embedded provider process belongs to one Next.js instance. When that instance exits, SQLite
still contains the Routa Session, but the process and in-memory manager entries disappear. Current
ownership checks reject the expired binding instead of taking it over. For Claude CLI sessions,
the native session ID emitted by `system/init` is not persisted, so `claude --resume` cannot be
used reliably after restart.

The existing recreation paths also write the newly created ACP/provider ID back into
`routa_agent_id`. For a Team Lead, that field contains the logical coordinator Agent ID. Replacing
it during recovery breaks Agent lookup and Team orchestration even if the provider process starts.

This creates two bad outcomes:

1. a Team looks active but follow-up messages cannot reach an Agent;
2. keeping many child processes alive becomes the only way to preserve provider context, increasing
   memory, CPU, connection, and file-descriptor pressure.

## Scope

This design covers:

- top-level Team Lead sessions and visible child Agent sessions;
- web embedded and runner execution modes;
- provider-aware runtime recovery;
- safe release of idle or completed provider runtimes;
- Team UI status and prompt-error behavior;
- equivalent product semantics for the Rust desktop backend.

## Non-goals

- Migrating provider runtimes between machines while a lease is still active.
- Preserving provider-private hidden reasoning that the provider does not expose.
- Exactly-once execution across an unclean crash.
- Building a general distributed scheduler.
- Merging unrelated Team Runs or user-visible Routa Sessions.
- Keeping every child Agent process warm indefinitely.

## Identity and ownership boundaries

The following identifiers must not be conflated:

| Identity | Meaning | Lifetime |
|---|---|---|
| Team Run ID | One user-visible Team execution tree | Durable |
| Agent ID | Logical Lead or member identity | Durable within the Team |
| Routa Session ID | User-visible transcript and execution record | Durable |
| Provider | Runtime family such as Claude, Codex, or OpenCode | Durable session metadata |
| Provider Session ID | Provider-native conversation used for native resume | Durable when supplied |
| Owner Instance ID | Backend instance currently allowed to run the provider | Temporary lease |
| Provider process | OS process, SDK stream, container, or remote connection | Replaceable |

For runtime recovery, one Agent keeps the same Routa Session. Starting a replacement process must
not create a new user-visible Session or hide earlier messages.

Child Sessions created for delegated tasks remain separate because they represent distinct visible
work units. Restarting a child runtime does not create another child Session.

Recovery writes obey two hard invariants:

1. `id`, `routa_agent_id`, `parent_session_id`, role, and specialist identity do not change.
2. A provider-native ID is written only to `provider_session_id`; it never replaces the logical
   Agent ID.

Because the in-memory Session store uses replacement-style upserts, recovery must rebuild a complete
record from durable metadata before writing it. A partial recovery record must not erase the name,
branch, parent link, model, Team chain, or specialist metadata.

## Minimal durable record

Use the existing `acp_sessions` record as the recovery descriptor. The recovery path requires:

- `id`: Routa Session ID
- `routa_agent_id`: logical Agent identity
- `provider`
- `provider_session_id`: provider-native resume ID when available
- `role` and `specialist_id`
- `model`
- `cwd` and `branch`
- `parent_session_id`
- `execution_mode`, `owner_instance_id`, and `lease_expires_at`

Runtime-only fields that affect Team behavior must also be reconstructible from durable metadata:

- Team Lead MCP profile (`team-coordination`)
- allowed native tools and permission mode
- specialist system prompt and its stable source ID
- Team chain policy when configured

Prefer deriving stable configuration from `specialist_id`, provider, and built-in policy IDs instead
of copying large generated prompts into new tables.

No new recovery table is required for the first version. The Web schema, persistence DTOs, Postgres,
SQLite, JSONL compatibility record, and Rust contract must nevertheless model
`provider_session_id` consistently. A column found in an existing local SQLite file is not sufficient
when the TypeScript schemas and stores cannot read or write it. Add a normal migration in sequence
after the current schema head.

Custom provider commands remain resolved through the existing provider registry in the first
version. If the referenced provider configuration no longer exists, recovery fails visibly instead
of guessing a command.

### Storage changes

The Web migration adds nullable `provider_session_id TEXT` to `acp_sessions` where it is absent and
updates both Drizzle schemas, persistence DTOs, Postgres and SQLite stores, JSONL compatibility, and
Session hydration. The Rust store already models this field and remains the parity reference. The
field is not unique: providers control its format and two workspaces must not be coupled by a global
database constraint.

No lease version column is required. The primary-key lookup plus expected owner and expiry values
are sufficient for the conditional takeover. The migration must preserve all existing
`routa_agent_id` values; it must not backfill `provider_session_id` from `routa_agent_id` because
those values have different meanings for Team Leads.

History persistence adds an atomic `appendHistoryOnce(sessionId, eventId, notification)` operation.
For the current JSON/JSONB history representation, the store performs the event-ID check and append
inside one database transaction. This is the durable acknowledgement used for prompt and child
report retries; it does not require a new event table in the first version.

## Runtime states

Reuse the existing Session status vocabulary instead of adding a parallel API model:

| Product meaning | Existing API representation |
|---|---|
| Provider runtime is live | `continuityStatus=active` |
| Durable Session can be resumed | `continuityStatus=restorable` |
| No supported recovery path | `continuityStatus=interrupted` |
| Historical Session outside the active window | `continuityStatus=stale` |
| Recovery is in progress | `acpStatus=connecting` |
| Recovery failed | `acpStatus=error` plus the real error |

`completed` remains a task/session outcome, not a guarantee that an OS process is still alive.

The Team UI may label `restorable` as “Suspended” and `connecting` as “Recovering”, but the first
version does not add another `runtimeStatus` field. Continuity must be computed from the actual
process manager and persisted binding; a stale persisted `acpStatus=ready` must not make a dead
runtime appear active.

### State transitions

The following transitions are normative. `continuityStatus` is derived for reads; it is not stored
as a second source of truth.

| Trigger | Before | During | Success | Failure |
|---|---|---|---|---|
| New Session starts | no Session | `acpStatus=connecting` | `active` + `acpStatus=ready` | `interrupted` + `acpStatus=error` |
| Runtime is safely released | `active` | active until finalization finishes | `restorable` | remain `active` or surface cleanup error |
| Backend or provider exits | `active` | — | `restorable` when recovery is supported | `interrupted` |
| Prompt wakes a Session | `restorable` | `acpStatus=connecting` | `active` + `acpStatus=ready` | `restorable` or `interrupted` + `acpStatus=error` |
| Active lease belongs elsewhere | any local state | no transition | join/retry when possible | return ownership conflict |
| Task completes | any runtime state | — | task outcome is `completed` | runtime state is unchanged |

After a failed native resume, the Session remains `connecting` while the one permitted context
rebuild is attempted. Only the final outcome is exposed as `ready` or `error`.

## Runtime recovery contracts

### One internal dispatch boundary

Both backends expose one internal operation. All user prompts, explicit Resume requests, and child
completion reports call this operation before talking to a provider:

```ts
type RuntimeRecoveryTrigger = "user_prompt" | "child_report" | "explicit_resume";

interface EnsureSessionRuntimeInput {
  sessionId: string;              // durable Routa Session ID
  trigger: RuntimeRecoveryTrigger;
  deliveryId: string;             // idempotency key for the triggering delivery
}

interface EnsureSessionRuntimeResult {
  sessionId: string;              // always the same Routa Session ID
  provider: string;
  resumeMode: "attached" | "native" | "recreated";
  ownerInstanceId?: string;
  providerSessionIdPersisted: boolean;
}

ensureSessionRuntime(input): Promise<EnsureSessionRuntimeResult>
```

`ensureSessionRuntime` performs durable load, ownership resolution, Team binding restoration, and
provider recovery. It is single-flight per Routa Session within one backend instance. Callers must
not contain their own Claude-, Codex-, or OpenCode-specific recreation branches.

`deliveryId` does not identify a provider conversation. For a user prompt it is a client-generated
UUID retained across retries. For a child report it is deterministic:
`team-report:<parent-session-id>:<child-session-id>:<task-id>:<report-revision>`.
An explicit Resume uses a request UUID prefixed with `resume:` and has no transcript message to
deduplicate.

### Existing public ACP API

The first version keeps `/api/acp`; it does not add a Team-only recovery endpoint.

`session/load` is the explicit Resume operation:

```json
{
  "jsonrpc": "2.0",
  "id": "request-id",
  "method": "session/load",
  "params": {
    "sessionId": "routa-session-id",
    "cwd": "optional-validated-override"
  }
}
```

The browser never supplies `providerSessionId`, provider commands, credentials, role, Agent ID, or
Team bindings during recovery. The backend loads those fields from the durable Session and the
provider/specialist registries.

A successful load keeps the current response shape:

```json
{
  "sessionId": "routa-session-id",
  "provider": "claude",
  "role": "ROUTA",
  "acpStatus": "ready",
  "resumeMode": "native",
  "resumeCapabilities": {
    "supported": true,
    "mode": "both"
  }
}
```

`session/prompt` performs implicit recovery by calling `ensureSessionRuntime` first. Add a required
`promptId` for Team dispatch and preserve it across client retries. The backend acknowledges the
prompt only after it has atomically recorded the user message/delivery and accepted it for the
resolved runtime. It emits a `session/update` with `sessionUpdate=prompt_accepted` and `promptId`;
the Team composer clears only after that acknowledgement. Duplicate `promptId` values return or
re-emit the existing acknowledgement and do not append or execute the prompt twice.

The Web SSE endpoint may continue returning HTTP `409` for a live foreign owner. JSON-RPC methods
use the following stable error envelope:

```ts
interface RuntimeRecoveryErrorData {
  reason:
    | "session_not_found"
    | "runtime_owned"
    | "recovery_unavailable"
    | "recovery_failed"
    | "workspace_unavailable"
    | "provider_configuration_missing";
  retryable: boolean;
  ownerInstanceId?: string;
  leaseExpiresAt?: string;
  retryAfterMs?: number;
}
```

| JSON-RPC code | Reason | Retry policy |
|---|---|---|
| `-32602` | invalid parameters | fix request; do not retry automatically |
| `-32004` | `session_not_found` | do not retry |
| `-32010` | `runtime_owned` | retry after the lease hint; never create locally |
| `-32011` | `recovery_unavailable` | require configuration or user action |
| `-32012` | `recovery_failed` | show error; retry only from a new trigger |
| `-32013` | workspace or provider configuration unavailable | show the concrete missing dependency |

`recovery_failed` (-32012) additionally carries a Team binding discriminator when the all-or-nothing
restoration fails: `data.failure = "missing_team_metadata"` (retryable false, plus
`data.missingMetadata`) or `data.failure = "team_bindings_incomplete"` (retryable true, plus
`data.missingBindings` and optionally `data.unmappedSessionIds`). Both backends emit the same
structured fields; clients branch on them, never on message text.

Web and Rust return the same JSON-RPC codes and `data.reason` values. Human-readable messages may
differ, but client behavior must depend on the structured fields.

### Provider recovery adapter

Provider-specific behavior is limited to this contract (the concrete language shape may differ):

```ts
type ProviderRecoveryCapability = "native_resume" | "context_rebuild" | "unavailable";

interface ProviderRecoveryRequest {
  routaSessionId: string;
  providerSessionId?: string;
  cwd: string;
  workspaceId: string;
  model?: string;
  role?: string;
  mcpProfile?: string;
  recoveryEnvelope?: string;
}

interface ProviderRecoveryResult {
  runtimeSessionId: string;
  providerSessionId?: string;
  resumeMode: "native" | "recreated";
}

interface ProviderRecoveryAdapter {
  capability(request: ProviderRecoveryRequest): ProviderRecoveryCapability;
  recover(request: ProviderRecoveryRequest): Promise<ProviderRecoveryResult>;
}
```

The adapter may return a runtime-local ID, but persistence updates only `provider_session_id` with
the provider-native ID. It never changes `id` or `routa_agent_id`. Successful startup is not exposed
as safely suspendable until the provider-native ID is stored or the adapter explicitly declares
context-rebuild-only behavior.

### Lease store contract

Replace read-then-save ownership changes with one store primitive:

```ts
interface TryAcquireExpiredLeaseInput {
  sessionId: string;
  expectedOwnerInstanceId?: string;
  expectedLeaseExpiresAt?: string;
  nextOwnerInstanceId: string;
  nextLeaseExpiresAt: string;
  now: string;
}

type LeaseAcquisitionResult =
  | { status: "acquired" | "already_owned"; ownerInstanceId: string; leaseExpiresAt: string }
  | { status: "conflict"; ownerInstanceId: string; leaseExpiresAt?: string }
  | { status: "missing" };

tryAcquireExpiredLease(input): Promise<LeaseAcquisitionResult>
```

The conditional update succeeds only when the Session exists and either has no owner, already has
the requesting owner, or still matches the expired owner/lease values read by the caller. A blank
lease is not permission to overwrite a different known owner without including that owner in the
compare condition.

Keep the existing default lease duration of 300 seconds
(`ROUTA_ACP_SESSION_LEASE_SECONDS`). While a runtime is alive, refresh at least every 60 seconds or
one third of the configured lease duration, whichever is shorter, and also at prompt acceptance.
Stop heartbeats before releasing the runtime. A recovery contender may take over only after the
persisted lease has expired and its compare-and-set succeeds.

## End-to-end recovery chain

Recovery is triggered by a user prompt, a child completion report addressed to the Lead, or an
explicit Resume action.

```text
Prompt or child report
  -> load durable Routa Session
  -> resolve provider + Agent role + specialist
  -> route to runner when execution_mode=runner
  -> otherwise inspect embedded ownership
  -> atomically acquire an expired lease
  -> rebuild Team orchestration bindings
  -> recover through the provider adapter
  -> deliver the prompt/report
  -> append output to the original Routa Session
```

### 1. Load and validate

Load the Session from the in-memory store or durable store. Reject only when the durable Session is
missing, deleted, or lacks required workspace and provider metadata.

### 2. Resolve execution owner

- Same owner with a live runtime: use it.
- Runner mode: proxy to the configured runner.
- Different owner with an active lease: return a conflict and do not start a duplicate runtime.
- Different owner with an expired lease: acquire ownership with one compare-and-set operation.

The compare-and-set must include the previous owner and lease value so only one backend instance
wins. Implement it as a conditional update in both Web stores and return whether a row changed;
do not reuse the current read-then-save binding helper. SQLite and Postgres may use different SQL,
but they expose the same `tryAcquireExpiredLease` behavior.

After losing the compare-and-set race, the request re-reads the binding. It may join an in-flight
recovery owned by the same local instance; otherwise it returns a retryable ownership conflict. It
must not start another provider process. An expired lease is recoverable state, not a permanent
error.

Lease acquisition is fail-closed. It returns one of five structured outcomes — `acquired`,
`already_owned`, `conflict`, `missing`, or `unavailable` — and callers branch on that result. Any
storage error maps to `unavailable` and blocks recovery with a retryable `recovery_unavailable`
error: a runtime whose ownership cannot be verified is never started. `missing` is reported only
when a successful query finds no durable row (JSONL-only sessions), never on a failed query. Prompt
dispatch re-checks ownership through a checked dispatch heartbeat: a lost lease stops dispatch and
isolates the runtime; a lease that cannot be verified stops dispatch fail-closed without killing
the runtime.

### 3. Restore Team bindings

Before prompting a recovered Lead:

- initialize or obtain the Team orchestrator;
- register the durable Lead Agent ID against the original Routa Session ID;
- load descendant Sessions by `parent_session_id`;
- rebuild Agent-to-Session mappings for existing members;
- restore the `team-agent-lead` specialist and `team-coordination` MCP profile;
- reinstall the notification and child-session-registration handlers used by Team creation;
- retain current task and child completion state from durable stores.

This step is all-or-nothing: every binding — Lead Agent mapping, descendant Session mappings, child
records, notification handler, child-session-registration handler, and Team MCP profile — is either
fully rebuilt or restoration reports a structured failure without mutating partial orchestrator
state. Restoration validates before it mutates. Missing durable metadata (for example the Lead's
`routaAgentId`) is reported as `missing_team_metadata` and is not retryable; store, handler, or
child-record failures and descendants that lack a durable `routa_agent_id` are reported as
`team_bindings_incomplete` and are retryable. Recovery answers either failure with a structured
`recovery_failed` (-32012) error before starting any runtime, so a ROUTA Lead never silently
degrades into a chat-only session. Attached live runtimes are exempt: their bindings were installed
in-process when the runtime was created. The Team UI keeps history and composer input and shows the
localized failure.

Child completion delivery must use the same recover-aware dispatch entry point as a user prompt.
It must not call an in-memory Claude process directly. If the Lead is suspended, the report is kept
durably, recovery runs, and the report is delivered once to the original Lead Session.

The child report delivery sequence is:

1. Persist task outcome and report content.
2. Derive the deterministic `deliveryId` from parent Session, child Session, task, and report
   revision.
3. Append a pending delivery event with `appendHistoryOnce`.
4. Call `ensureSessionRuntime` for the parent.
5. Submit the report using the same `deliveryId`.
6. Persist `delivered` after provider prompt acceptance, then finalize the child runtime.

Retries reuse the same delivery ID. A repeated event does not add another user-visible report.
Routa guarantees idempotent durable delivery and at-least-once recovery attempts; it does not claim
exactly-once provider execution across a crash after provider acceptance but before the delivered
receipt is persisted.

### 4. Recover through the provider adapter

Each provider declares one of three small capabilities:

| Capability | Behavior |
|---|---|
| `native_resume` | Resume using `provider_session_id` |
| `context_rebuild` | Start a runtime and inject a bounded recovery context |
| `unavailable` | Return a visible recovery error |

Initial provider handling:

- Claude CLI: persist the `system/init.session_id`; restart with `--resume`.
- Codex and standard ACP providers: use `session/load` when supported.
- OpenCode and SDK providers: use their native session identifier when supported.
- Any provider without a usable native session: use context rebuild.

Do not build one large provider-specific branch in the Team page. Recovery belongs behind the ACP
provider/runtime adapter boundary.

### 5. Bounded context rebuild

Native resume may be unsupported or fail because provider-local data was removed. The fallback
starts a new provider conversation but keeps the original Routa Session.

The recovery context contains only:

- Team objective;
- Lead role and specialist policy;
- current task tree and incomplete tasks;
- member roster and latest child status;
- completed child reports and blocking errors;
- a bounded recent transcript or compact durable summary;
- repository/worktree identity and current branch.

It must not depend on hidden reasoning or replay every raw streaming chunk. After context rebuild,
new provider events append to the original Routa transcript.

Use one provider-neutral recovery envelope. Adapters inject it through an existing supported
channel: a session/system append when the provider supports it, otherwise a clearly marked prefix
on the first resumed user message. The envelope is not rendered as a second user-authored message
in the Team timeline. Provider adapters must not invent separate recovery-context formats.

### 6. Deliver and persist

Only clear the user's composer after the provider accepts the prompt. Persist the refreshed owner
lease and provider-native session ID before treating the runtime as recoverable.

## Capturing provider session IDs

Provider-native IDs must be captured as soon as the provider exposes them:

- Claude CLI: when `ClaudeCodeProcess` receives `system/init`, emit a callback that stores
  `session_id` in `provider_session_id`.
- ACP: persist the ID returned by `session/new` or `session/load`.
- SDK and OpenCode adapters: persist the adapter's stable native identifier.

`routa_agent_id` must never be used as a fallback provider session ID for a Team Lead. It identifies
the logical coordinator Agent, not the provider conversation.

Provider ID persistence is part of provider startup, not a best-effort UI update. The process is not
considered safely suspendable until the native ID has been stored, or the provider has been marked
as context-rebuild-only.

## Runtime release and resource bounds

Logical Sessions stay durable; provider runtimes do not.

Minimum policy:

- keep a runtime while a prompt is streaming or a tool call is active;
- release a completed child runtime after history and traces are flushed;
- permit a future idle Lead TTL only after version-one recovery metrics prove it safe;
- do not protect every child process merely because the parent Session record exists;
- keep Team execution concurrency bounded by the existing delegation/queue policy;
- on shutdown, flush durable history before terminating owned processes when possible.

Release performs:

1. flush transcript and trace buffers;
2. stop the provider process, SDK stream, or container;
3. close MCP and SSE runtime resources;
4. remove transient manager entries;
5. keep Session, Agent, Team, task, and history records;
6. expose `continuityStatus=restorable`, which the Team UI may label “Suspended”.

Use the existing session runtime finalizer as the release boundary rather than adding a second
cleanup subsystem. The remaining work is to connect completed/idle Team policy to that boundary
and verify that active parent/child dependencies do not keep completed child processes alive
forever.

The first version does not need automatic pre-warming or an idle Lead TTL. Recovery happens on
demand; completed child release is the first resource-control target.

### Release policy contract

| Trigger | Version-one action | Automatic retry |
|---|---|---|
| Completed child | Release immediately after its report is accepted and durable buffers flush | retry on the next lifecycle/cleanup trigger |
| Explicit Disconnect | Release immediately; preserve Session and history | user may retry Disconnect |
| Backend shutdown | Best-effort flush and release owned runtimes | next startup treats missing runtimes as suspended |
| Provider crash | Stop advertising active after liveness check/lease expiry | next prompt/report recovers |
| Idle Lead | Do not release automatically in version one | deferred |
| Deleted Session or Team | Use deletion policy after finalization | existing deletion retry behavior |

Automatic completed-child release is allowed only when all checks pass:

- no prompt stream is active;
- no tool call or user-input request is pending;
- the completion report has a durable delivery receipt;
- history and trace flush succeeded;
- no active dependency still requires the child runtime;
- a provider-native ID is persisted, or the adapter is explicitly context-rebuild-only.

Extend the existing finalizer result instead of returning a Boolean:

```ts
type SessionFinalizationSkipReason =
  | "auto-release-disabled"
  | "streaming"
  | "pending-interaction"
  | "report-not-delivered"
  | "history-not-durable"
  | "active-dependency"
  | "recovery-not-ready";
```

There is no background retry loop in version one. A skipped or incomplete release keeps the
runtime record and is reconsidered by the next completion, disconnect, memory-cleanup, or shutdown
trigger. This bounds implementation complexity and avoids a second scheduler.

## API and UI behavior

Session detail responses continue to expose the existing continuity and capability fields:

```json
{
  "continuityStatus": "restorable",
  "acpStatus": null,
  "resumeCapabilities": {
    "supported": true,
    "mode": "both"
  }
}
```

Do not expose provider credentials or internal command arguments to the browser.

Team UI behavior:

- never label a Session `working` solely because it is the Team Lead;
- map `restorable`, `connecting`, and `error` to clear Suspended, Recovering, and Failed labels;
- sending to a suspended Session may trigger recovery automatically;
- preserve composer text until prompt acceptance;
- display ownership and recovery errors instead of suppressing them;
- provide one Retry/Resume action after recoverable failure.

The client currently suppresses some retryable ownership conflicts. Recovery work must redefine
that rule: suppress only a conflict that is actively being retried or joined locally; otherwise show
the error. Team prompt dispatch must await acceptance before remounting or clearing the composer.

## Web and desktop boundary

Web and desktop must preserve the same semantics:

- one durable Routa Session across runtime replacements;
- provider-aware native resume with context-rebuild fallback;
- no duplicate takeover while an ownership lease is active;
- runtime release does not delete transcript history.

Implementation details may differ:

- Web uses Next.js routes, `AcpProcessManager`, and the database-backed execution binding.
- Desktop uses Axum; `AppState.acp_manager` (`routa_core::acp::AcpManager`) owns the provider
  `AcpProcess` runtimes, and recovery kills/recreates sessions through that manager — desktop DOES
  hold provider runtimes, usually under one local server process.

The web implementation may land first for the reproduced failure. Desktop does not need to copy the
Web lease columns when it has a single local owner, but it must expose equivalent continuity and
resume-capability semantics and must keep the same Routa Session across runtime replacement.

The response contract is field-for-field compatible:

| Field | Web | Rust | Rule |
|---|---|---|---|
| `sessionId` | required | required | Routa Session ID, never provider ID |
| `provider` | required after hydration | required after hydration | normalized provider registry ID |
| `role` | optional for legacy rows | optional for legacy rows | restored from durable metadata |
| `acpStatus` | `connecting/ready/error` | same | transient recovery state |
| `continuityStatus` | four existing values | same | derived from liveness plus capability |
| `resumeMode` | `attached/native/recreated` | same | result of the latest load |
| `resumeCapabilities` | existing shape | same | adapter capability, not UI guesswork |
| `nativeResumeError` | optional | optional | diagnostic from native fallback |

Contract tests run the same fixtures against the TypeScript and Rust serializers. Desktop may omit
owner details when there is only one local owner; it may not change status or recovery meanings.

## Failure handling

- Native resume fails: attempt context rebuild once.
- Context rebuild fails: set `acpStatus=error`, keep history, compute continuity from the remaining
  recovery capability, and return the real error.
- Lease acquisition loses a race: join a same-instance in-flight recovery or return a retryable
  conflict; do not spawn another runtime.
- Process exits during a prompt: persist received events and leave the Session recoverable.
- Provider session ID is absent: never pretend native resume succeeded.
- Required repository/worktree is missing: fail visibly; do not silently switch to another cwd.
- Child completion arrives while the Lead is suspended: persist it before recovery and route it
  through the same bounded dispatch path.
- Team binding restoration fails or durable Team metadata is missing: fail recovery with a
  structured `recovery_failed` error; never start a chat-only runtime; keep history and composer
  input.
- Lease verification fails during dispatch: stop prompt delivery; isolate the runtime only when the
  lease is known-lost, and fail closed without killing it when the lease cannot be verified.

Automatic recovery is bounded to one native attempt plus one context-rebuild attempt per trigger.
Further retries require a new user action or supervisor event.

### Version-one policy values

| Policy | Version-one value |
|---|---|
| Embedded lease duration | existing default 300 seconds; environment-configurable |
| Lease heartbeat | every 60 seconds or one third of lease duration, whichever is shorter |
| Same-instance recovery concurrency | one in-flight recovery per Routa Session |
| Native resume attempts | one per trigger |
| Context rebuild attempts | at most one after unsupported/failed native resume |
| Completed child release | immediately after durable report acceptance and release checks |
| Idle Lead release | disabled |
| Recovery pre-warming | disabled |
| Automatic recovery-error retry | none beyond the native-to-rebuild fallback |
| Prompt/report deduplication | durable `deliveryId`; retained with Session history |
| Seven-day stale threshold | picker classification only; never deletes a Session |

These values are deliberately conservative. Configuration may be added after metrics show a real
need, but Web and desktop must not silently ship different default semantics.

## Implementation sequence

### Phase 1: make failure visible

- correct `continuityStatus` so persisted `ready` does not override a missing runtime;
- stop hard-coding Team Lead as `working`;
- preserve composer input and render prompt errors;
- define which ownership conflicts are retried and which are shown;
- add structured JSON-RPC recovery error data and Web/Rust contract fixtures;
- connect the existing Resume capability to the same entry point as prompt dispatch.

### Phase 2: persist and resume

- persist provider-native session IDs;
- preserve `routa_agent_id` and the complete durable Session record during recovery;
- add `ProviderRecoveryAdapter` and `ensureSessionRuntime` boundaries;
- add `tryAcquireExpiredLease` for atomic takeover and lease heartbeat;
- restore Team Lead and descendant mappings plus both Team handlers before dispatch;
- add durable `deliveryId`/`appendHistoryOnce` and route child reports through recover-aware dispatch;
- define one provider-neutral context-rebuild envelope and injection channel.

### Phase 3: release safely

- connect completed child policy to the existing runtime finalizer;
- add pending-interaction, durable-report, history, dependency, and recovery-readiness checks;
- verify history/trace flush and resource cleanup;
- keep idle Lead suspension disabled and record it as a separate follow-up after recovery metrics;
- add Web/Rust lifecycle contract coverage.

Each phase is independently useful and should be delivered in baby-step commits.

## Acceptance criteria

- Restarting Next.js does not make an existing Team permanently read-only.
- A recovered Lead keeps the same Agent ID and Routa Session ID.
- Recovery never overwrites `routa_agent_id` with an ACP or provider Session ID.
- Historical messages remain visible and new replies append to the same timeline.
- Claude recovery uses the persisted native session ID when available.
- A missing native ID follows context rebuild without creating a new user-visible Session.
- The recovered Lead can list and message existing child Agents.
- A child completion report can wake a suspended Lead without being dropped or delivered twice.
- Completed or idle child runtimes can be released without deleting history.
- Concurrent recovery attempts create at most one provider runtime.
- A duplicate user `promptId` or child-report `deliveryId` does not append or dispatch twice during
  normal retries.
- Prompt errors remain visible and unsent composer content is retained.
- The composer clears only after the matching durable `prompt_accepted` acknowledgement.
- Ownership and recovery failures use the documented structured error reasons.
- ROUTA Lead recovery never silently degrades to a chat-only runtime when Team binding restoration
  fails; the failure is structured, retryability is explicit, and history and input are preserved.
- Completed-child release is skipped with a specific reason while streaming, awaiting interaction,
  lacking a durable report, or lacking a safe recovery path.
- Web and desktop expose compatible runtime-state semantics.

## Verification

Characterization and regression coverage should include:

- provider session ID persistence from Claude `system/init`;
- logical Agent ID and complete Session metadata remain unchanged across recovery;
- process-manager recreation with a native resume ID;
- expired-lease compare-and-set takeover;
- active-lease duplicate prevention;
- lease heartbeat during a prompt/tool call longer than one lease interval;
- same-instance recovery single-flight behavior;
- Team orchestrator rehydration from durable parent/child records, including both handlers;
- child completion delivery through a suspended Lead recovery;
- duplicate user prompt and child-report delivery IDs;
- crash between provider acceptance and durable delivery receipt, documenting the at-least-once
  limitation without duplicating the visible history event;
- context-rebuild fallback when native resume data is absent;
- recovery-envelope injection without a duplicate user-authored timeline message;
- same Routa Session ID before and after restart;
- runtime release and every skip reason with transcript and trace preservation;
- Team composer behavior on recovery failure;
- all-or-nothing Team binding restoration: each failure path (missing metadata, store outage,
  unmappable descendant, handler installation failure) leaves no partial registration and yields
  the structured failure;
- lease acquisition fail-closed behavior: DB failure maps to `unavailable` (no runtime start) and
  only a successful empty query maps to `missing`;
- prompt dispatch stops on a lost or unverifiable lease, isolating the runtime only when lost;
- Web/Rust parity for the Team binding failure envelope (code -32012, reason `recovery_failed`,
  `failure` discriminator, retryability);
- Web/Rust response-shape parity for runtime status.

Run graph impact probes before implementation, then use the repository fitness tiers required by
the changed runtime, API, and UI surfaces.
