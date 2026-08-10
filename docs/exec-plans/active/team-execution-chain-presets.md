# Team Execution Chain Presets

## Status

Proposed. This document is for architecture and implementation review. It does not authorize implementation by itself.

## Goal

Allow users to choose the delivery strength of a Team Run before it starts, so small tasks do not always execute the current full software-delivery chain.

The first version adds three new chain presets while preserving the current Team behavior as `full_delivery`:

- `investigation`
- `lightweight`
- `standard_delivery`
- `full_delivery` (current behavior)

## Current State

The Team page currently launches every run with the same configuration:

- the root session is locked to `team-agent-lead`
- the role is `ROUTA`
- the MCP profile is resolved to `team-coordination`
- the selected repository is attached to the workspace
- the initial prompt is sent after the Team Run detail page selects the new ACP session

The Team Lead prompt is currently optimized for complete software delivery. It requires delegation, research when context is unknown, independent verification after implementation, and evidence before completion. This is appropriate for large work, but it makes small changes use more agents and tokens than necessary.

Relevant implementation points:

- `src/app/workspace/[workspaceId]/team/team-page-client.tsx`
- `src/client/components/home-input.tsx`
- `src/client/acp-client.ts`
- `src/client/hooks/use-acp.ts`
- `src/app/api/acp/acp-session-create.ts`
- `src/core/acp/http-session-store.ts`
- `src/core/acp/session-db-persister.ts`
- `crates/routa-server/src/api/acp_routes.rs`
- `crates/routa-core/src/store/acp_session_store.rs`
- `resources/specialists/team/agent-lead.yaml`

## Decisions

### 1. A chain is an orchestration policy, not a specialist

Roles and chains remain separate:

- a specialist defines who performs work
- a chain defines how many stages, agents, and verification gates are expected

Do not create chain-specific specialists such as `quick-fix-lead` or `standard-delivery-frontend`.

### 2. The user makes the final selection

The Team launch surface may recommend a chain, but the user selects the chain before starting the run.

The MVP recommendation is deterministic and local. It must not start an Agent or call a model just to choose a chain.

### 3. The selected chain is explicit session metadata

Add an optional root-session field:

```ts
type TeamChainId =
  | "investigation"
  | "lightweight"
  | "standard_delivery"
  | "full_delivery";
```

The field name is `teamChainId` in JSON and `team_chain_id` in persistence.

Do not overload:

- `modeId`, because it is provider-specific ACP session mode
- `mcpProfile`, because it controls tool exposure
- `specialistId`, because a chain is not a specialist
- the Session name, because display text is user-editable

### 4. The backend owns policy prompt construction

The client sends only a validated `teamChainId`. The backend resolves that ID into a concise chain-policy prompt and appends it to the existing Team Lead specialist prompt.

This prevents the UI from becoming the authority for orchestration behavior and keeps Web/Desktop semantics aligned.

### 5. No new workflow engine in the MVP

The current Team is prompt-driven. The first version keeps that model.

The MVP does not add:

- a DAG engine
- persisted chain-step state
- a new background-task type
- tool-level agent-count enforcement
- automatic mid-run chain transitions

These can be considered later if prompt compliance is insufficient.

## Chain Definitions

### Investigation

Purpose: understand a problem without modifying the target repository.

Expected execution:

```text
Team Lead -> Researcher -> evidence-backed report -> Team Lead summary
```

Policy:

- delegate at most one researcher at a time
- do not assign implementation work
- do not edit source files
- do not create an independent QA or code-review stage
- return root cause, evidence, impact, options, and recommended next chain

### Lightweight

Purpose: complete a small, bounded task with one implementation specialist.

Expected execution:

```text
Team Lead -> one implementation specialist -> self-verification -> Team Lead delivery
```

Policy:

- do not launch a separate research wave
- delegate to at most one child Agent
- the child may investigate the local scope, implement, and run targeted verification
- do not launch independent QA or code review by default
- stop and report when the task requires another specialty, public API changes, database changes, security-sensitive work, or broader verification

Examples include a local UI adjustment, a small component feature, a bounded refactor, or a clearly scoped bug fix.

### Standard Delivery

Purpose: handle normal product work with implementation and independent verification.

Expected execution:

```text
Team Lead -> primary implementer -> QA or code reviewer -> Team Lead delivery
```

Policy:

- use one primary implementation specialist
- research is optional and only used when the affected area cannot be identified safely
- require one independent verifier after implementation
- keep no more than two child sessions active at once
- use targeted or affected-scope validation rather than full delivery governance unless risk expands

This should be the default recommendation for ordinary development requests.

### Full Delivery

Purpose: preserve the current Team behavior for complex or high-risk delivery.

Expected execution:

```text
Research/design -> decomposition -> specialist implementation waves
-> independent QA -> code review when warranted -> Team Lead delivery
```

Policy:

- retain the current `team-agent-lead` rules
- allow research before implementation
- allow multiple specialties and small parallel waves
- require independent verification
- require evidence before completion
- use code review for non-trivial or high-risk changes

For backward compatibility, existing Team Runs without `teamChainId` are interpreted as `full_delivery`.

## Recommendation Rules

The recommendation helper is advisory. It returns a chain and short reason; it does not inspect the repository.

Recommended deterministic order:

1. Explicit analysis-only intent such as “analyze”, “investigate”, or “do not modify” -> `investigation`.
2. High-risk signals such as database migration, authorization, security, payment, or cross-backend delivery -> `full_delivery`.
3. Explicitly bounded local scope such as one named component/file or a small visual change -> `lightweight`.
4. Otherwise -> `standard_delivery`.

The selector must clearly label the result as a recommendation. The user can choose any chain before launch.

No model fallback is included in the MVP. If deterministic confidence is low, recommend `standard_delivery`.

## Runtime Flow

```text
User enters request
  -> UI recommends and displays a chain
  -> user selects chain
  -> HomeInput creates the Team Lead session with teamChainId
  -> Web or Rust backend validates teamChainId
  -> backend persists teamChainId on the root ACP session
  -> backend appends the matching policy to the Team Lead prompt
  -> existing pending-prompt flow sends the user request
  -> Team Lead delegates through existing team-coordination MCP tools
  -> Team Run UI reads and displays the persisted chain
```

## API and Persistence Changes

### ACP session creation

Extend `session/new` with an optional property:

```json
{
  "specialistId": "team-agent-lead",
  "teamChainId": "standard_delivery"
}
```

Validation rules:

- accept only the four known values
- accept `teamChainId` only for a top-level `team-agent-lead` session
- reject invalid values with the existing JSON-RPC invalid-params error shape
- if the Team Lead omits the value, use `full_delivery`
- child sessions inherit Team ownership through `parentSessionId`; they do not copy `teamChainId`

### Session storage

Persist the selected ID on the root ACP Session in:

- TypeScript in-memory session record
- Postgres `acp_sessions`
- Node SQLite `acp_sessions`
- Rust SQLite `acp_sessions`
- local session metadata where applicable

Expose `teamChainId` from Session list/detail responses so the Team UI can restore and display it after refresh.

No separate Team Chain table is needed because presets are built-in policy definitions, not user-authored workflow instances.

### API contract

Update `api-contract.yaml` for the optional Session field and ensure Next.js/Rust parity.

## UI Scope

Add a compact chain selector to the Team launcher near the input controls.

Each option shows:

- localized name
- one-sentence purpose
- expected Agent pattern
- verification strength

Suggested labels:

| ID | Chinese | English |
|---|---|---|
| `investigation` | 调查分析 | Investigation |
| `lightweight` | 轻量执行 | Lightweight |
| `standard_delivery` | 标准交付 | Standard Delivery |
| `full_delivery` | 完整交付 | Full Delivery |

The Team Run detail header displays the persisted chain as read-only metadata.

All strings must use the existing i18n system.

## Prompt Boundary

`resources/specialists/team/agent-lead.yaml` remains the canonical role definition.

Its current complete-delivery rules should become the default `full_delivery` behavior. Add one explicit rule stating that a validated runtime Team Chain Policy defines the required stages for the current run; Full Delivery defaults apply only when no narrower policy is present.

The generated policy section should be short and operational. It must specify:

- allowed delivery stages
- maximum child-agent shape
- verification requirement
- stop/escalation conditions
- completion output

Do not duplicate the full Agent Lead prompt into four files.

## Escalation Boundary

The MVP does not silently change chains during execution.

If a Lead or child Agent discovers that the selected chain is unsafe or insufficient, it must:

1. stop expanding the work
2. explain the newly discovered scope or risk
3. recommend a stronger chain
4. wait for the user to start or explicitly authorize broader execution

Automatic chain mutation and historical transition tracking are out of scope for the MVP.

## Expected File Areas

The implementation should remain concentrated in these areas:

### Shared/client

- a small Team Chain type/preset/recommendation module under the Team feature area or `src/core/orchestration/`
- Team launcher selector
- `HomeInput` session creation parameters
- Team Run header/display model
- i18n types and locale values

### TypeScript backend

- ACP `session/new` validation and prompt-policy composition
- HTTP Session record and session API DTO
- Session persistence schema/store migration

### Rust backend

- ACP `session/new` parsing and validation
- ACP Session record/store migration
- Session API DTO parity
- equivalent prompt-policy composition

### Contract/resources

- `api-contract.yaml`
- `resources/specialists/team/agent-lead.yaml`

Avoid changes to Kanban workflow definitions, background workflows, shared sessions, A2A, AG-UI, or unrelated specialists.

## Testing Strategy

### Unit tests

- recommendation rules return the expected preset
- every preset resolves to the expected concise policy
- invalid chain IDs are rejected
- non-Team sessions cannot set `teamChainId`
- missing Team chain defaults to `full_delivery`
- Lightweight policy permits one implementer and requires self-verification
- Standard policy requires one independent verifier
- Investigation policy prohibits implementation

### Component tests

- Team launcher displays four localized choices
- user selection overrides the recommendation
- selected `teamChainId` is passed during Session creation
- Team Run header restores the persisted chain

### Persistence and API tests

- Postgres/SQLite session round-trip preserves `teamChainId`
- Rust SQLite round-trip preserves `teamChainId`
- Next.js and Rust Session DTOs expose the same value
- legacy sessions without the field still appear as Full Delivery

### Validation

Because this changes shared Session semantics and both backends:

```bash
entrix graph impact
entrix graph test-radius
entrix run --tier fast
entrix run --tier normal
```

Focused tests should run before the repository-wide gates.

## Rollout

1. Add the shared enum, policy resolver, persistence field, and dual-backend contract support.
2. Add the selector and Team Run chain display behind a Team-chain feature flag if needed.
3. Update the Team Lead prompt boundary and enable the presets.
4. Observe child-session counts, completion rates, user-requested escalations, and token usage by chain.
5. Consider hard orchestration enforcement only if prompt compliance is unreliable.

## Non-Goals

- user-authored chain definitions
- drag-and-drop workflow building
- model-based chain selection
- automatic token estimation
- automatic mid-run chain switching
- changing the Team specialist roster
- replacing ACP or MCP
- changing Kanban automation
- enforcing model/provider choice per chain

## Acceptance Criteria

- A user can select one of four Team chains before launch.
- Existing Team behavior remains available as Full Delivery.
- Existing or legacy Team Runs without chain metadata behave as Full Delivery.
- The selected chain survives refresh and backend restart.
- Web and Desktop expose the same chain semantics.
- Investigation cannot be instructed by its chain policy to implement changes.
- Lightweight requests no more than one implementation child session and no independent verifier by default.
- Standard Delivery includes implementation plus one independent verification stage.
- The solution reuses the existing Team Lead, ACP Session, MCP delegation, and Team Run UI.
- No new workflow engine or chain-specific specialist files are introduced.

## Review Questions

Reviewers should focus on these decisions:

1. Is `teamChainId` correctly modeled as root Session metadata rather than a new Team Run table?
2. Is prompt-level enforcement sufficient for the MVP?
3. Are the four chain boundaries mutually understandable and operationally distinct?
4. Is defaulting legacy runs to `full_delivery` the safest compatibility behavior?
5. Are any required Web/Rust persistence or recovery paths missing from the file scope?
6. Should Standard Delivery use QA by default, or select QA versus code reviewer based on the task type?
