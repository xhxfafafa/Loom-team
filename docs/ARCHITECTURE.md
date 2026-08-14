---
status: canonical
purpose: Canonical architecture overview for the Loom-team Web-only runtime boundaries, domain model, protocol stack, and invariants.
principles:
  - Workspace-first scope over hidden global state
  - Single Next.js backend for UI, API, and agent runtime
  - Protocol-oriented orchestration over provider-specific coupling
  - Local-first development (SQLite) with production Postgres deployment
  - Durable system boundaries over endpoint-by-endpoint duplication
update_policy:
  - Keep this file focused on stable architecture and invariants.
  - Put route and endpoint inventory in docs/product-specs/FEATURE_TREE.md.
  - Put design intent and transition rationale in docs/design-docs/.
---

# Loom-team Architecture

Loom-team is a workspace-first multi-agent coordination platform with a single runtime surface:

- Web: Next.js app and API in `src/`, with the TypeScript domain core in `src/core/`

This is the Web-only edition of the product (see [loom-team-web-only-migration.md](./design-docs/loom-team-web-only-migration.md)). The former Tauri desktop shell and the Rust backend crates were removed; the Web-facing capabilities they provided (ACP runtime management, sandbox policy, worktree and file operations, fitness engines) were ported to TypeScript/Node under `src/core/` and `scripts/fitness/`.

## Core Principles

- Workspace-first: workspaces are the top-level coordination boundary for sessions, tasks, notes, boards, codebases, worktrees, and memories.
- Single backend, one contract: the Next.js backend is the only runtime and implements `api-contract.yaml`, the single source of truth for the API surface.
- Protocol-oriented orchestration: REST, MCP, ACP, and SSE are all first-class integration surfaces.
- Local-first execution: SQLite persistence, local agent binaries, local worktrees, and trace files for development; Postgres for production deployment.
- Provider abstraction: different agent CLIs and runtimes are normalized behind adapter layers instead of leaking provider-specific protocol details through the system.

## Repository Shape

| Area | Purpose |
|---|---|
| `src/app/` | Next.js App Router pages and API routes |
| `src/client/` | Client components, hooks, view models, A2UI helpers |
| `src/core/` | TypeScript domain logic: stores, ACP/MCP, kanban automation, workflows, notes, tools, fitness |
| `scripts/fitness/` | TypeScript fitness-function runners and gate helpers |
| `api-contract.yaml` | OpenAPI contract: single source of truth for the backend API |
| `docs/` | Durable architecture, design intent, plans, fitness guidance |

## Runtime Topology

### Web Runtime

- Next.js serves pages under `src/app/`.
- API handlers in `src/app/api/` use the TypeScript `RoutaSystem` from `src/core/routa-system.ts`.
- `RoutaSystem` selects storage by environment:
  - `DATABASE_URL` -> Postgres-backed stores
  - `ROUTA_DB_DRIVER=sqlite` or local Node runtime -> SQLite-backed stores
  - fallback -> in-memory stores
- Real-time updates are delivered mainly through SSE endpoints and in-process event broadcasting.
- Capabilities that used to live in the Rust backend (ACP process and runtime management, sandbox policy resolution, worktree and file operations, codebase scanning, trace parsing, fitness evaluation) now live in the TypeScript domain core (`src/core/acp/`, `src/core/sandbox/`, `src/core/trace/`, `src/core/fitness/`, and related modules).

## Architecture Model

The runtime follows one layered shape:

```text
Presentation
  React pages, workspace views, session detail, kanban, settings, traces

API / Transport
  Next.js route handlers

Protocol Adapters
  REST, MCP, ACP, SSE, JSON-RPC normalization

Domain Services
  orchestration, kanban automation, workflow execution, notes, review, scheduling,
  trace, harness, fitness, worker dispatch

Stores / Registries
  workspace, task, session, note, codebase, worktree, schedule, artifact, skill

Persistence / Runtime
  Postgres, SQLite, in-memory, JSONL traces, local processes, Docker, filesystem
```

Dependency direction should stay downward. UI and transport layers depend on domain services; stores and runtime layers should not depend on UI concerns.

## Primary Domain Boundaries

### Workspace

Workspace is the primary user-visible scope. Users navigate by workspace first and then inspect sessions, boards, notes, tasks, codebases, or memories within that scope.

Current canonical background:
- [workspace-centric-redesign.md](./design-docs/workspace-centric-redesign.md)

Important invariant:
- New product surfaces should require explicit workspace context unless they are deliberate bootstrap flows.

### Codebase And Worktree

- A workspace can own multiple codebases.
- A codebase models repo identity and metadata such as path, branch, label, and default status.
- Worktrees are ephemeral or semi-persistent execution copies tied to a workspace and codebase.
- File search, sandbox resolution, and repo selection should flow through codebase/worktree context instead of hidden global repo state.

### Session

- A session represents a live or historical agent execution thread.
- Sessions are workspace-scoped and power the session detail page, trace views, and automation status.
- Session history may live in database rows and/or JSONL traces.
- ACP is the primary execution transport for agent CLIs, but some providers require adapter translation.

### Task And Kanban

- Tasks are the durable work units.
- Kanban is not just a UI projection; it also drives lane-based automation and queueing.
- Column transitions can trigger fresh ACP sessions and enrich tasks with provider/role/session metadata.
- The TypeScript queue in `src/core/kanban/kanban-session-queue.ts` enforces per-board concurrency and prevents stale auto-run entries from re-firing incorrectly.

### Background Task And Workflow

- Background tasks model durable async work such as scheduled runs, polling-triggered actions, or workflow fan-out.
- Workflows convert a higher-level automation definition into multiple background tasks with dependency ordering.
- Schedule ticks, webhook events, and polling adapters can all enqueue background tasks instead of invoking execution inline.

### Trace And Review

- Traces record session lifecycle, messages, tool calls, file changes, and VCS context for audit and debugging (`src/core/trace/`).
- Trace data is a first-class debugging and attribution mechanism, not an incidental log stream.
- Review provides multi-phase code review with findings, severity, and validation context (`src/core/review/`).

### Harness And Worker

- Harness detects repository signals, script entrypoints, and spec sources to power governance and quality analysis (`src/core/harness/`).
- The harness loop model (`Context -> Run -> Observe -> Govern`) is documented in [docs/harness/](./harness/); stable records remain `Task / Run / Workspace / EvalSnapshot / PolicyDecision / Evidence`.
- Fitness functions are enforced by the TypeScript fitness engine (`src/core/fitness/`, `scripts/fitness/`) and by `npm run validate:web` / `npm run validate:web:e2e` in CI.
- Workers abstract local and Docker-based execution environments (`src/core/worker/`).
- Sandbox policy resolution enforces workspace-aware Docker constraints in TypeScript (`src/core/sandbox/`).

### Note, Memory, Artifact

- Notes support collaborative knowledge capture and use CRDT-based real-time behavior on the TypeScript side.
- Runtime/process memory monitoring is a system API at `/api/system/memory`.
- Workspace delivery memory is a product domain for evidence-backed contextual records and must use explicit product surfaces such as `/api/workspace-memory`, `/api/agent-memory`, or `/api/memory-pack` when those layers are implemented.
- Artifacts are structured outputs exchanged between agents, workflows, or coordination tools.

## System Factory And Shared State

`src/core/routa-system.ts` is the central assembly point for the runtime. It wires:

- stores for agents, conversations, tasks, notes, workspaces, codebases, worktrees, schedules, kanban boards, background tasks, workflow runs, and artifacts
- `EventBus` for in-process coordination
- MCP-facing tool surfaces such as `AgentTools`, `NoteTools`, and `WorkspaceTools`
- note broadcasting and CRDT document management
- permission storage used by runtime permission delegation flows

This file is the service container. New domain services should usually be introduced here rather than instantiated ad hoc inside route handlers.

## Protocol Stack

| Protocol | Primary endpoints | Role |
|---|---|---|
| REST | `/api/*` | CRUD and product-facing operations |
| MCP | `/api/mcp`, `/api/mcp/tools` | tool execution and collaborative agent capabilities |
| ACP | `/api/acp` and related runtime/registry/docker routes | spawn, prompt, stream, install, warm up, and manage agent runtimes |
| A2UI | `/api/a2ui/*` | dashboard-oriented UI protocol surfaces |
| SSE | ACP, notes, and related endpoints | incremental updates to the frontend |

The product surface changes often. For endpoint inventory, use [docs/product-specs/FEATURE_TREE.md](./product-specs/FEATURE_TREE.md) rather than expanding this document into an API catalog.

## ACP And Provider Architecture

ACP is the main execution protocol for coding agents, but providers do not behave identically.

The normalization pattern is:

```text
Provider process or bridge
  -> provider-specific output / notifications
  -> adapter normalization
  -> unified session updates
  -> persistence, traces, and UI streaming
```

Current provider/runtime concerns include:

- standard ACP-compatible CLIs
- Claude Code style stream-json flows that must be translated into ACP-like updates
- Docker-backed OpenCode execution paths
- runtime installation, warmup, and registry discovery

The ACP subsystem lives under `src/core/acp/` with routes under `src/app/api/acp/`.

## Real-Time And Eventing

There are two main real-time mechanisms:

- transport-level streaming: mainly SSE for session, note, and protocol updates
- in-process eventing: `EventBus` in the TypeScript runtime

These support:

- agent lifecycle tracking
- kanban auto-run queue draining
- note change propagation
- workflow and background-task coordination
- UI refresh triggers for session and trace surfaces

## Persistence Model

- Primary persistent target is Postgres when `DATABASE_URL` is configured (production).
- SQLite is the local-first development store (`ROUTA_DB_DRIVER=sqlite`).
- In-memory mode remains available for tests and lightweight runtime scenarios.
- Filesystem state is also part of persistence: session JSONL traces, repos, worktrees, agent binaries, and local config.

### Traces And History

- Session and trace history may be stored in database records, JSONL files, or both.
- Trace data is a first-class debugging and attribution mechanism, not an incidental log stream.

## Current Transitional Areas

The repository is still finishing the workspace-centric normalization. The durable status lives in [docs/design-docs/workspace-centric-redesign.md](./design-docs/workspace-centric-redesign.md), but the key architecture caveat is:

- some paths still fall back to `"default"` when workspace scope is omitted
- some bootstrap/runtime flows still assume a default workspace exists
- some workflow-run persistence remains in-memory even when other stores are persistent

Treat `"default"` as transition scaffolding, not as the target domain model.

## Architecture Decision Records

The `docs/adr/` directory captures durable architectural decisions that shape boundaries, protocols, and patterns across the codebase. ADRs are the canonical answer to "why is it built this way?"

Discover decisions via: `claude -p "What ADRs exist and what do they decide?"`

Current ADRs:

| ADR | Decision |
|---|---|
| [0001](./adr/0001-dual-backend-semantic-parity.md) | Superseded: Web and desktop shared domain semantics via api-contract.yaml; the Web-only migration removed the desktop backend |
| [0002](./adr/0002-provider-normalization-via-acp.md) | All agent runtimes normalized to ACP through adapter layers |
| [0003](./adr/0003-workspace-first-scope.md) | Workspaces are the top-level coordination boundary |
| [0004](./adr/0004-kanban-driven-automation.md) | Kanban lanes trigger ACP sessions with queued concurrency |
| [0005](./adr/0005-specialist-externalization.md) | Specialists as Markdown+YAML with priority loading |
| [0006](./adr/0006-orchestration-shell-pattern.md) | Complex files use thin shell + domain hooks structure |

## Related Documents

- Product/API index: [docs/product-specs/FEATURE_TREE.md](./product-specs/FEATURE_TREE.md)
- Architecture decisions: [docs/adr/](./adr/)
- Design intent: [docs/design-docs/](./design-docs/)
- Coding style: [docs/coding-style.md](./coding-style)
- Repository operating contract: `AGENTS.md` (repo root)
- [MCP Spec](https://modelcontextprotocol.io/) · [ACP Spec](https://github.com/agentclientprotocol/typescript-sdk)
