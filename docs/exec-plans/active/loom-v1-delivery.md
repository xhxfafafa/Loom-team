# Loom v1 Delivery Plan

## Goal

Deliver the six Loom v1 features (goal input, plan generation, task board, agent team, evidence review, delivery view) as a coherent local-first delivery workbench built on the existing Routa.js codebase.

## Why This Plan Exists

The product is being refocused from a general multi-agent coordination platform to a focused delivery workbench. Earlier work drifted into platform-infrastructure complexity (harness operator consoles, architecture rule DSLs, trace learning, AgentWatch TUI). This plan locks scope to the six user-visible features defined in [docs/design-docs/loom-v1-scope.md](../../design-docs/loom-v1-scope.md) and sequences the implementation work.

## Scope

In scope:
- F1: structured product goal input (goal text, repos, requirement docs, constraints)
- F2: plan generation, review, and programmatic confirm/reject gate
- F3: Kanban board column alignment to Loom v1 semantics
- F4: agent team role alignment and budget/handoff visibility
- F5: unified per-task evidence view and hard no-evidence-no-done enforcement
- F6: delivery overview with progress, risks, how-to-run, audit trail
- Navigation integration, i18n consolidation (en + zh)
- QA evidence gates (entrix fast/normal + UI walkthrough)

Out of scope:
- harness operator console, architecture rule DSL, trace learning phase 2, AgentWatch TUI (see [loom-v1-scope.md §Exclusions](../../design-docs/loom-v1-scope.md#explicit-exclusions-deferred-beyond-v1))
- A2A/AG-UI protocol work
- Rust-backend parity expansion
- ACP provider fleet reduction

## Current Evidence

- `/workspace/:id/goal` page exists (scaffolded); `/api/goals` and `/api/goals/[goalId]` routes exist
- `/workspace/:id/delivery` page exists (scaffolded); `/api/delivery/[workspaceId]` route exists
- Kanban board is ~90% complete with lane transitions and decompose API
- Team mode + Specialists + ACP is ~85% complete
- Transition gates, artifacts, and verdicts exist (~85%)
- `/traces` page and `/api/traces` exist for audit trail
- No `/api/plans` route or `/workspace/:id/plan` page exists yet (F2 is greenfield)

## Locked API Contracts

### ProductGoal

```
ProductGoal {
  id: string
  workspaceId: string
  goalText: string
  repos: Array<{ kind: 'local' | 'github', path?: string, url?: string }>
  requirementDocs: Array<{ name: string, content: string }>
  constraints: string[]
  status: 'draft' | 'active'
}
```

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/goals` | Create a new product goal |
| GET | `/api/goals?workspaceId={id}` | List goals for a workspace |
| GET | `/api/goals/[goalId]` | Get a specific goal |
| PUT | `/api/goals/[goalId]` | Update a goal |

### DevPlan

```
DevPlan {
  id: string
  workspaceId: string
  goalId: string
  status: 'draft' | 'confirmed' | 'rejected'
  scope: string[]
  nonGoals: string[]
  risks: Array<{ risk: string, mitigation?: string }>
  userStories: Array<{ id: string, title: string, story: string, acceptanceCriteria: string[] }>
  technicalApproach: string
  teamAllocation: Array<{ role: string, responsibility: string }>
  feedbackLog: string
  confirmedAt?: string (ISO timestamp)
}
```

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/plans` | Generate a development plan from a goal |
| POST | `/api/plans/[planId]/confirm` | Confirm plan (programmatic gate → triggers task decomposition onto kanban) |
| POST | `/api/plans/[planId]/reject` | Reject plan with `{ feedback: string }` |

The confirm endpoint is the **only** path that triggers Kanban task creation. This is a hard gate: no decomposition occurs without explicit plan confirmation.

### DeliveryReport

```
GET /api/delivery/[workspaceId] → {
  progress: { total: number, completed: number, inProgress: number, blocked: number }
  completed: Array<{ taskId, title, evidence: Array<{ type, url }> }>
  outstanding: Array<{ taskId, title, blocker?: string }>
  risks: Array<{ risk: string, mitigation?: string, source: string }>
  howToRun: string
  audit: Array<{ timestamp, action, agent, summary }>
}
```

## Waves

### Wave 1: F1 Goal Input + F6 Delivery View (parallel)

**F1: Product Goal Input**
- Complete `ProductGoal` domain model and persistence
- Implement `/api/goals` CRUD (create, read by workspace, read by id, update)
- Build `/workspace/:id/goal` page with structured form: goal text, repo references (local/github), requirement doc upload, constraints list
- Wire goal status lifecycle (draft → active)

**F6: Delivery View**
- Complete `DeliveryReport` aggregation logic in `/api/delivery/[workspaceId]`
- Build `/workspace/:id/delivery` page: progress summary, completed tasks with evidence links, outstanding tasks with blockers, risk summary, how-to-run section, audit trail timeline
- Link to `/traces` for detailed execution traces

Both features can proceed in parallel because F1 is input-only and F6 is read-only aggregation.

### Wave 2: F2 Plan Generation & Review + Docs Alignment

**F2: Plan Generation & Review**
- Implement `DevPlan` domain model and persistence
- Build `/api/plans` (generate from goal)
- Build `/api/plans/[planId]/confirm` — programmatic gate that triggers `POST /api/kanban/decompose` to create tasks on the board
- Build `/api/plans/[planId]/reject` with feedback capture
- Build `/workspace/:id/plan` page: plan display, scope/non-goals/risks/stories/approach/team view, confirm/reject buttons with feedback input
- Ensure confirm gate is the **only** path to task decomposition

**Docs alignment**: update this exec plan and related docs to reflect any scope adjustments discovered during Wave 1.

### Wave 3: F3 Board Alignment + F4 Team Role Alignment

**F3: Board Alignment**
- Align Kanban column labels to Loom v1 semantics (待澄清, 待执行, 开发中, 测试/审核, 已完成, 已阻塞)
- Ensure each task card displays: owner, dependencies, involved files, acceptance conditions, current evidence
- Wire per-task evidence requirement: block transition to 已完成 if no evidence attached

**F4: Team Role Alignment**
- Map existing specialist roles to Loom v1 role set (Product, Architect, Frontend, Backend, Test, Security)
- Add budget visibility per agent session (token count, cost estimate)
- Surface handoff events between agents in the team view
- Ensure traceable messages between team members

### Final: Integration + QA Evidence Gates

**Integration**
- Wire navigation: goal → plan → board → team → delivery as a coherent flow
- i18n consolidation: all new UI strings through `t()` with en + zh translations
- Cross-feature linking: goal page links to plan, plan links to board, board links to team sessions, delivery links back to all

**QA Evidence Gates**
- `entrix run --dry-run` passes (syntax and structural checks)
- `entrix run --tier fast` passes (fast automated checks)
- `entrix run --tier normal` passes (full behavioral checks when workflow/APIs changed)
- UI walkthrough with `agent-browser`: capture screenshots of each feature page showing end-to-end flow
- No task in Done column without attached evidence (manual verification)

## Hard Implementation Constraints

All implementation work must respect these invariants:

1. **entrix gates**: run `entrix run --dry-run` before any PR; run `--tier fast` for code changes; run `--tier normal` when behavior, shared modules, APIs, or workflow orchestration changed. If a check fails, fix and re-run; do not skip.

2. **Frontend API calls**: use `resolveApiPath` + `desktopAwareFetch` for all frontend API calls. Do not write raw `fetch('/api/...')` in components.

3. **i18n**: all UI-facing strings must go through the i18n system (`t('key')`) with both English (`en`) and Chinese (`zh`) translations. No hardcoded language literals in components.

4. **Thin route handlers**: API route handlers must be thin shells delegating to core domain modules. Extract workflow branches before shared helpers.

5. **Baby-step commits**: one commit = one concern with Conventional Commits format. Target budget: under 10 files and under 1000 changed lines per commit. Include related issue ID when applicable. Always add co-author line.

6. **No debug logs in production**: temporary `console.log` for diagnosis is allowed during development but must be removed before completion.

## Exit Criteria

This plan is successful when:

- an operator can input a product goal, generate and confirm a plan, see tasks decompose onto the board, watch agents execute with traceable handoffs, verify evidence per task, and view the final delivery summary — all within the Loom v1 web UI
- no task can reach Done without evidence
- `entrix run --tier normal` passes
- all UI strings have en + zh translations
- the audit trail from goal to delivery is navigable end-to-end
- all deferred capabilities (harness console, AgentWatch, trace learning, etc.) are documented as backlog without scope leakage into v1

## Related Documents

- [Loom v1 Scope](../../design-docs/loom-v1-scope.md)
- [Loom Feature Mapping](../../product-specs/loom-feature-mapping.md)
- [Architecture](../../ARCHITECTURE.md)
- [Fitness Rulebook](../../fitness/README.md)
- [Coding Style](../../coding-style.md)
