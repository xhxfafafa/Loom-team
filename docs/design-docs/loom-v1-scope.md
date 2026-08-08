---
title: Loom v1 Scope
status: canonical
created: 2026-08-09
---

# Loom v1 — Product Scope Statement

## Positioning

Loom v1 is a **local-first, auditable, traceable multi-agent software delivery workbench**. It is built on top of the existing Routa.js codebase and narrows the product from a general multi-agent coordination platform to a focused delivery tool that takes a product goal as input and produces a shippable increment with full evidence and audit trail.

Loom v1 is not a platform product. It is a delivery workbench: it helps a human operator define what to build, generates a plan, decomposes work, schedules a local agent team, collects evidence, and reports delivery status — all on a single machine with full traceability.

## The Six Features

### F1: Input Product Goal

Accept structured input describing what to build:

- free-text goal description
- optional repository references (local paths or GitHub URLs)
- optional requirement documents (name + content)
- optional technical constraints (list of strings)

The goal is persisted as a first-class domain object (`ProductGoal`) bound to the workspace. It replaces the current "workspace title only" behavior with a structured input surface.

**Status**: partially scaffolded — `/workspace/:id/goal` page and `/api/goals` route exist; domain model and persistence need completion.

### F2: Generate & Review Development Plan

Given an active `ProductGoal`, generate a structured development plan containing:

- scope (what is included)
- non-goals (what is explicitly excluded)
- risks (with optional mitigations)
- user stories (each with title, story text, acceptance criteria)
- technical approach
- team allocation (role + responsibility pairs)

The user **must explicitly confirm** the plan before any downstream work begins. The confirmation is a programmatic gate: `POST /api/plans/:id/confirm` triggers task decomposition onto the Kanban board. Rejection carries feedback that can inform the next generation attempt.

**Status**: not yet started — no `/api/plans` route or `/workspace/:id/plan` page exists.

### F3: Auto-Decompose Into Task Board

Decompose the confirmed plan into a Kanban board with columns:

- 待澄清 (Needs Clarification)
- 待执行 (Ready)
- 开发中 (In Progress)
- 测试/审核 (Review/Test)
- 已完成 (Done)
- 已阻塞 (Blocked)

Each task carries: owner, dependencies, involved files, acceptance conditions, and current evidence. The board is the single source of truth for delivery progress.

**Status**: ~90% complete — Kanban board with lane transitions exists; column semantics need alignment to the Loom v1 labels.

### F4: Schedule Local Agent Team

Orchestrate a local agent team with defined roles:

- Product (goal owner, scope decisions)
- Architect (technical approach, structure)
- Frontend (UI implementation)
- Backend (API and server implementation)
- Test (verification and quality)
- Security (security review)

Each agent session is traceable: messages, handoffs, token/cost budgets, and session identity are all recorded and visible.

**Status**: ~85% complete — Team mode, Specialists, and ACP exist; role-name alignment to the Loom v1 role set and budget/handoff visibility improvements needed.

### F5: Evidence-Driven Review

Every task requires evidence before it can transition to Done:

- code diffs
- test results
- artifacts (screenshots, logs, reports)
- acceptance verdict (pass/fail per acceptance criterion)

A task **cannot** be marked Done without attached evidence. This is a hard invariant of Loom v1.

**Status**: ~85% complete — transition gates, delivery readiness checks, artifact attachment, and verdict mechanisms exist; consolidation into a unified evidence view per task needed.

### F6: Final Delivery View

A single overview page showing the complete delivery status:

- done / not-done task counts and breakdown
- outstanding risks and blockers
- how to run and verify the delivered increment
- complete audit trail (linking to traces)

**Status**: partially scaffolded — `/workspace/:id/delivery` page and `/api/delivery/[workspaceId]` route exist; aggregation logic and UI need completion.

## Mapping to Existing Routa Capabilities

| Feature | Existing Routa Surface | Gap |
|---|---|---|
| F1 Goal Input | workspace title; `/workspace/:id/goal` page (scaffolded); `/api/goals` (scaffolded) | structured goal model, persistence, repo/doc upload |
| F2 Plan Generation | implicit via spec notes; prompt-level confirmation only | plan schema, `/api/plans`, programmatic confirm gate, plan review page |
| F3 Task Board | Kanban board (`backlog/todo/dev/review/done/blocked`); lane automation; decompose API | column label alignment, per-task evidence requirements |
| F4 Agent Team | Team mode; Specialists; ACP; session traces | role-name mapping to Loom roles, budget visibility, handoff UI |
| F5 Evidence Review | transition gates; delivery readiness; artifacts; verdicts | unified per-task evidence view, hard no-evidence-no-done enforcement |
| F6 Delivery View | `/workspace/:id/delivery` (scaffolded); `/api/delivery` (scaffolded); `/traces` | aggregation, risk summary, how-to-run section, audit trail integration |

## Boundary Principles

1. **User-visible features first.** Every increment of work should produce something the operator can see, interact with, or receive evidence from. Infrastructure work is justified only when it directly enables a user-visible feature.

2. **Runtime, DAG, and harness governance are background infrastructure.** The Routa harness, DAG execution, policy planes, and runtime orchestration are real capabilities, but they are not the product direction for Loom v1. They serve as plumbing, not as surfaces.

3. **No-evidence-no-done.** A task cannot transition to Done without attached evidence (diffs, test results, artifacts, verdicts). This is a hard invariant, not a guideline.

4. **Fully auditable.** Every agent action, message, handoff, and decision must be traceable through the audit trail. The delivery view must link to complete execution traces.

5. **Local-first.** Loom v1 runs on a single machine. It does not assume cloud services, shared state, or remote coordination. Repositories are local; agents are local; the operator is local.

## Explicit Exclusions (Deferred Beyond v1)

The following are real capabilities that exist as design material or partial implementations in the Routa.js codebase. They are recorded as backlog items, **not** v1 scope:

| Exclusion | Reason for Deferral |
|---|---|
| Harness operator console (`harness-monitor` run-centric TUI) | Platform infrastructure, not delivery workbench surface |
| Architecture Rule DSL | Governance tooling; useful but not required for delivery workflow |
| Trace Learning Phase 2 (runtime playbook loading, preflight guidance) | Learning system; v1 delivers traces, v2 learns from them |
| AgentWatch TUI | Separate TUI product surface; v1 uses web UI only |
| A2A / AG-UI protocols | Cross-system agent protocols; v1 is single-machine local |
| Rust-backend parity expansion | Dual-backend maintenance; v1 stabilizes on current web parity |
| ACP provider fleet reduction | Provider management optimization; not v1 delivery scope |

These exclusions remain valid future work. They are tracked in `docs/exec-plans/archived/` where applicable, and may re-enter scope for Loom v2 or subsequent Routa platform releases.

## Related Documents

- [Loom v1 Delivery Plan](../exec-plans/active/loom-v1-delivery.md)
- [Loom Feature Mapping](../product-specs/loom-feature-mapping.md)
- [Architecture](../ARCHITECTURE.md)
- [Execution Modes](./execution-modes.md)
- [Product Feature Tree](../product-specs/FEATURE_TREE.md)
