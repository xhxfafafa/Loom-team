# Loom v1 Feature Mapping

This document maps the six Loom v1 features to their routes, pages, APIs, and source files. It complements [FEATURE_TREE.md](./FEATURE_TREE.md), which is the auto-generated product and API surface index. This document focuses on the Loom v1 delivery scope only.

See also: [Loom v1 Scope](../design-docs/loom-v1-scope.md) · [Loom v1 Delivery Plan](../exec-plans/active/loom-v1-delivery.md)

---

## F1: Input Product Goal

Structured input for what to build: goal text, repos, requirement docs, constraints.

### Pages

| Route | Source File | Status |
|---|---|---|
| `/workspace/:workspaceId/goal` | `src/app/workspace/[workspaceId]/goal/page.tsx` | scaffolded |

### APIs

| Method | Path | Purpose | Status |
|---|---|---|---|
| POST | `/api/goals` | Create a product goal | scaffolded |
| GET | `/api/goals?workspaceId={id}` | List goals for a workspace | scaffolded |
| GET | `/api/goals/[goalId]` | Get a specific goal | scaffolded |
| PUT | `/api/goals/[goalId]` | Update a goal | scaffolded |

### API Route Sources

- `src/app/api/goals/route.ts`
- `src/app/api/goals/[goalId]/route.ts`

### Domain Model

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

---

## F2: Generate & Review Development Plan

Plan generation from goal, with explicit confirm/reject gate before decomposition.

### Pages

| Route | Source File | Status |
|---|---|---|
| `/workspace/:workspaceId/plan` | *(new)* | not started |

### APIs

| Method | Path | Purpose | Status |
|---|---|---|---|
| POST | `/api/plans` | Generate a plan from a goal | not started |
| POST | `/api/plans/[planId]/confirm` | Confirm plan → trigger task decomposition | not started |
| POST | `/api/plans/[planId]/reject` | Reject plan with feedback | not started |

### Domain Model

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
  confirmedAt?: string
}
```

### Key Constraint

The confirm endpoint is the **only** path that triggers Kanban task creation. No decomposition occurs without explicit plan confirmation.

---

## F3: Auto-Decompose Into Task Board

Kanban board with Loom v1 column semantics and per-task evidence requirements.

### Pages

| Route | Source File | Status |
|---|---|---|
| `/workspace/:workspaceId/kanban` | `src/app/workspace/[workspaceId]/kanban/page.tsx` | shipped |

### APIs

| Method | Path | Purpose | Status |
|---|---|---|---|
| GET | `/api/kanban/boards` | List boards for workspace | shipped |
| POST | `/api/kanban/boards` | Create a board | shipped |
| GET | `/api/kanban/boards/{boardId}` | Get a board | shipped |
| PATCH | `/api/kanban/boards/{boardId}` | Update a board | shipped |
| POST | `/api/kanban/decompose` | Decompose into tasks | shipped |
| GET | `/api/kanban/events` | SSE stream for board events | shipped |
| GET | `/api/kanban/export` | Export boards as YAML | shipped |
| POST | `/api/kanban/import` | Import boards from YAML | shipped |

### API Route Sources

- `crates/routa-server/src/api/kanban.rs`
- `src/app/api/kanban/boards/route.ts`
- `src/app/api/kanban/boards/[boardId]/route.ts`
- `src/app/api/kanban/decompose/route.ts`
- `src/app/api/kanban/events/route.ts`
- `src/app/api/kanban/export/route.ts`
- `src/app/api/kanban/import/route.ts`

### Column Alignment

| Current Kanban Column | Loom v1 Label | Notes |
|---|---|---|
| backlog | 待澄清 (Needs Clarification) | label alignment needed |
| todo | 待执行 (Ready) | label alignment needed |
| dev | 开发中 (In Progress) | label alignment needed |
| review | 测试/审核 (Review/Test) | label alignment needed |
| done | 已完成 (Done) | label alignment needed; hard evidence gate required |
| blocked | 已阻塞 (Blocked) | label alignment needed |

---

## F4: Schedule Local Agent Team

Multi-agent team with defined roles, traceable messages, handoffs, and budgets.

### Pages

| Route | Source File | Status |
|---|---|---|
| `/workspace/:workspaceId/team` | `src/app/workspace/[workspaceId]/team/page.tsx` | shipped |
| `/workspace/:workspaceId/team/:sessionId` | `src/app/workspace/[workspaceId]/team/[sessionId]/page.tsx` | shipped |

### Related Settings

| Route | Source File | Purpose |
|---|---|---|
| `/settings/specialists` | `src/app/settings/specialists/page.tsx` | Configure specialist personas and bindings |

### APIs

| Method | Path | Purpose | Status |
|---|---|---|---|
| GET | `/api/specialists` | List configured specialists | shipped |
| POST | `/api/specialists` | Create a specialist | shipped |
| PUT | `/api/specialists` | Update a specialist | shipped |
| DELETE | `/api/specialists` | Delete a specialist | shipped |

### API Route Sources

- `crates/routa-server/src/api/specialists.rs`
- `src/app/api/specialists/route.ts`

### Role Alignment

| Loom v1 Role | Current Specialist Mapping | Notes |
|---|---|---|
| Product | *(to be mapped)* | goal owner, scope decisions |
| Architect | *(to be mapped)* | technical approach, structure |
| Frontend | *(to be mapped)* | UI implementation |
| Backend | *(to be mapped)* | API and server implementation |
| Test | *(to be mapped)* | verification and quality |
| Security | *(to be mapped)* | security review |

---

## F5: Evidence-Driven Review

Per-task evidence collection and hard no-evidence-no-done gate.

### Capabilities (composed from existing surfaces)

| Capability | Source | Status |
|---|---|---|
| Transition gates | Kanban lane automation | shipped |
| Artifact attachment | `/api/tasks/[taskId]/artifacts` | shipped |
| Delivery readiness | transition gate checks | shipped |
| Acceptance verdicts | task verdict mechanism | shipped |

### APIs

| Method | Path | Purpose | Status |
|---|---|---|---|
| GET | `/api/tasks/[taskId]/artifacts` | List task artifacts | shipped |
| GET | `/api/tasks/[taskId]/changes` | List task changes | shipped |
| GET | `/api/tasks/[taskId]/changes/stats` | Change statistics | shipped |
| GET | `/api/tasks/[taskId]/runs` | List task runs | shipped |
| PATCH | `/api/tasks/[taskId]/status` | Update task status | shipped |

### API Route Sources

- `src/app/api/tasks/[taskId]/artifacts/route.ts`
- `src/app/api/tasks/[taskId]/changes/route.ts`
- `src/app/api/tasks/[taskId]/changes/stats/route.ts`
- `src/app/api/tasks/[taskId]/runs/route.ts`
- `src/app/api/tasks/[taskId]/status/route.ts`

### Hard Invariant

A task **cannot** transition to 已完成 (Done) without attached evidence (diffs, test results, artifacts, or verdicts). This is enforced at the transition gate level.

---

## F6: Final Delivery View

Delivery overview: progress, risks, how-to-run, and complete audit trail.

### Pages

| Route | Source File | Status |
|---|---|---|
| `/workspace/:workspaceId/delivery` | `src/app/workspace/[workspaceId]/delivery/page.tsx` | scaffolded |
| `/traces` | `src/app/traces/page.tsx` | shipped |

### APIs

| Method | Path | Purpose | Status |
|---|---|---|---|
| GET | `/api/delivery/[workspaceId]` | Delivery report for a workspace | scaffolded |
| GET | `/api/traces` | List agent execution traces | shipped |
| GET | `/api/traces/{id}` | Get a single trace | shipped |
| POST | `/api/traces/export` | Export traces in Agent Trace format | shipped |
| GET | `/api/traces/stats` | Aggregated trace statistics | shipped |

### API Route Sources

- `src/app/api/delivery/[workspaceId]/route.ts`
- `crates/routa-server/src/api/traces.rs`
- `src/app/api/traces/route.ts`
- `src/app/api/traces/[id]/route.ts`
- `src/app/api/traces/export/route.ts`
- `src/app/api/traces/stats/route.ts`

### Response Shape

```
GET /api/delivery/[workspaceId] → {
  progress: { total, completed, inProgress, blocked }
  completed: [{ taskId, title, evidence: [{ type, url }] }]
  outstanding: [{ taskId, title, blocker? }]
  risks: [{ risk, mitigation?, source }]
  howToRun: string
  audit: [{ timestamp, action, agent, summary }]
}
```

---

## Navigation Flow

The six features form a sequential delivery flow with back-links:

```
F1 Goal → F2 Plan → F3 Board → F4 Team → F5 Review → F6 Delivery
   ↑          ↑                              ↑            │
   └──────────┴──────────────────────────────┴────────────┘
                    (back-links for context)
```
