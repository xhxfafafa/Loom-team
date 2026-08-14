---
dimension: api_contract
weight: 10
tier: normal
threshold:
  pass: 100
  warn: 90

metrics:
  - name: api_contract_parity
    command: npm run api:check 2>&1
    hard_gate: true
    tier: fast

  - name: web_api_contract_schema_test
    command: npm run api:test:schema 2>&1
    hard_gate: false
    tier: normal
---

# Web API Contract Testing Evidence

> This file records the testing status of API endpoints as evidence for the maintainability dimension.

## Rules
- API regression checks are recorded at the endpoint, method, success-path, negative-path, and regression-path layers.
- Updates to this file follow the layered rule process:
  - First follow the working principles and submission flow in AGENTS.md;
  - Then align behavioral requirements and scoring prerequisites per `docs/fitness/README.md`;
  - Finally register endpoint-level entries with executable evidence in this file.
- Any new change must update this file before committing; coverage claims only in PR descriptions are not allowed.

## Endpoint Matrix (must be executable)

Status markers:
- `VERIFIED`: Test exists and passes reliably (provide file path)
- `BLOCKED`: Currently blocked (provide reason and owner)
- `TODO`: Not started / not yet completed

| Module | Route | Scenario | Required Cases | Status | Evidence |
|---|---|---|---|---|---|
| workspace | `GET /api/workspaces` | list | Default workspace existence and stable list return | VERIFIED | `src/app/api/workspaces/__tests__/route.test.ts` |
| workspace | `POST /api/workspaces` | success | Create success + response field validation | VERIFIED | `src/app/api/workspaces/__tests__/route.test.ts` |
| workspace | `POST /api/workspaces` | invalid input | Empty name / illegal parameter 400 | VERIFIED | `src/app/api/workspaces/__tests__/route.test.ts` |
| workspace | `GET /api/workspaces/:id` | not found | 404 + fixed error text | VERIFIED | `src/app/api/workspaces/[workspaceId]/__tests__/route.test.ts` |
| workspace | `PATCH /api/workspaces/:id` | update | Title update and return consistency | VERIFIED | `src/app/api/workspaces/[workspaceId]/__tests__/route.test.ts` |
| workspace | `POST /api/workspaces/:id/archive` | archive | Post-archive state is readable and explicit | VERIFIED | `src/app/api/workspaces/[workspaceId]/archive/__tests__/route.test.ts` |
| workspace | `DELETE /api/workspaces/:id` | delete | Post-delete 404 | VERIFIED | `src/app/api/workspaces/[workspaceId]/__tests__/route.test.ts` |
| note | `GET /api/notes` | success chain | list/get/get-by-id consistency | VERIFIED | `src/app/api/notes/__tests__/route.test.ts` |
| note | `POST /api/notes` | success | Create success path | VERIFIED | `src/app/api/notes/__tests__/route.test.ts` |
| note | `POST /api/notes` | validation | Validation failure scenario | TODO | `src/app/api/notes/__tests__/route.test.ts` |
| note | `DELETE /api/notes` | delete | Delete success and reference cleanup | VERIFIED | `src/app/api/notes/__tests__/route.test.ts` |
| note | `GET /api/notes` | query by workspaceId/noteId | workspace and noteId parameter coverage | VERIFIED | `src/app/api/notes/__tests__/route.test.ts` |
| task | `GET /api/tasks` | list/filter | Filter parameters and sort boundaries | VERIFIED | `src/app/api/tasks/__tests__/route.test.ts` |
| task | `POST /api/tasks/{id}/status` | state machine | Invalid transition returns conflict/error | VERIFIED | `src/app/api/tasks/[taskId]/status/__tests__/route.test.ts` |
| task | `GET /api/tasks/{id}` | get | Post-create/update persistence readability | VERIFIED | `src/app/api/tasks/[taskId]/__tests__/route.test.ts` |
| task | `PATCH/DELETE /api/tasks/{id}` | update/delete | PATCH and DELETE behavior consistency | VERIFIED | `src/app/api/tasks/[taskId]/__tests__/route.test.ts` |
| task | `POST /api/tasks` | create | Create success and field validation | VERIFIED | `src/app/api/tasks/__tests__/route.test.ts` |
| task | `GET /api/tasks?teamRunId=` | team run filter + workspace isolation | Positive filter returns only tasks bound to this workspace with the given teamRunId; unbound tasks and other workspace tasks excluded; unknown teamRunId returns 200 + empty array | VERIFIED | `src/app/api/tasks/__tests__/route.test.ts`, `src/core/orchestration/__tests__/team-chain.test.ts` |
| kanban | `POST /api/kanban/import` | import | YAML import success and return applied details | VERIFIED | `src/app/api/kanban/import/__tests__/route.test.ts` |
| kanban | `GET /api/kanban/export` | export + validation | YAML export success; missing `workspaceId` returns 400 | VERIFIED | `src/app/api/kanban/export/__tests__/route.test.ts` |
| codebase | `POST /api/workspaces/{workspaceId}/codebases` | create + duplicate handling | Bare repo rejected, create returns 201, conflict return semantic consistency | VERIFIED | `src/app/api/workspaces/[workspaceId]/codebases/__tests__/route.test.ts` |
| codebase | `POST /api/workspaces/{workspaceId}/codebases` | non-git folder import | Plain directory codebase returns 201 with `git=false`; bare repo still rejected | VERIFIED | `src/app/api/workspaces/[workspaceId]/codebases/__tests__/route.test.ts` |
| clone | `POST /api/clone/local` | local folder load (git optional) | Plain directory returns 200 + `git=false` without triggering git commands; git repos still return branch/status; missing path, file path, unreadable path return 400 | VERIFIED | `src/app/api/clone/local/__tests__/route.test.ts` |
| codebase | `GET /api/files/search` | search path | Missing repoPath returns 400; result visibility and scan count correct | VERIFIED | `src/app/api/files/search/__tests__/route.test.ts` |
| codebase | `PATCH /api/codebases/{id}` | update | Update fields success | VERIFIED | `src/app/api/codebases/[codebaseId]/__tests__/route.test.ts` |
| codebase | `POST /api/codebases/{id}/default` | set default | Default target readable and correct | VERIFIED | `src/app/api/codebases/[codebaseId]/default/__tests__/route.test.ts` |
| codebase | `DELETE /api/codebases/{id}` | delete | Global delete success returns ok | VERIFIED | `src/app/api/codebases/[codebaseId]/__tests__/route.test.ts` |
| codebase | `DELETE /api/workspaces/{workspaceId}/codebases/{codebaseId}` | workspace-scoped delete | Workspace mismatch returns 404; match deletes successfully | VERIFIED | `src/app/api/workspaces/[workspaceId]/codebases/[codebaseId]/__tests__/route.test.ts` |
| clone | `DELETE /api/clone/branches` | delete local branch | Successfully delete local issue branch; current branch returns 409; missing branch returns 404 | TODO | `src/app/api/clone/branches/__tests__/route.test.ts` |
| github | `GET /api/github/pulls` | list workspace-linked pulls | workspace/codebase resolution, 400/404 negative paths, return PR metadata | TODO | `src/app/api/github/pulls/route.ts` |
| harness | `GET /api/harness/templates` | list templates | Repo context resolution and template list return | TODO | `src/app/api/harness/templates/route.ts` |
| harness | `GET /api/harness/templates/validate` | validate template | Missing templateId returns 400; success returns validation result | TODO | `src/app/api/harness/templates/validate/route.ts` |
| harness | `GET /api/harness/templates/doctor` | doctor templates | Repo context resolution and diagnostic result return | TODO | `src/app/api/harness/templates/doctor/route.ts` |
| spec | `GET /api/spec/issues` | list local issue specs | `repoPath` success path returns normalized issue metadata; illegal path returns 400; skips bad files and normalizes `closed` to `resolved` | VERIFIED | `src/app/api/spec/issues/__tests__/route.test.ts` |
| fitness | `GET /api/fitness/architecture` | architecture report | Repo context resolution and architecture report return | TODO | `src/app/api/fitness/architecture/route.ts` |
| task | `GET /api/tasks/{id}/changes` | repo/worktree change summary | Task missing returns 404; no repo returns empty changes; with repo returns status/files/baseRef/commits | VERIFIED | `src/app/api/tasks/[taskId]/changes/__tests__/route.test.ts` |
| github | `GET /api/github/issues` | list workspace-linked issues | workspace/codebase resolution, 400/404 negative paths, return issue metadata | BLOCKED | `env: requires controllable GitHub API stub or injectable base URL` |
| ACP | `POST /api/acp` | initialize | Initialization returns protocol metadata | VERIFIED | `src/core/acp/__tests__/` |
| ACP | `POST /api/acp` | unknown method | Method not found returns fixed structure | VERIFIED | `src/core/acp/__tests__/` |
| agents | `POST /api/agents` | create/list/get | Successful create and query chain | VERIFIED | `src/app/api/agents/__tests__/route.test.ts` |
| agents | `POST /api/agents/{id}/status` | invalid status | Illegal status returns 400 | VERIFIED | `src/app/api/agents/[agentId]/status/__tests__/route.test.ts` |
| agents | `DELETE /api/agents/{id}` | delete | Post-delete get returns 404 | VERIFIED | `src/app/api/agents/[agentId]/__tests__/route.test.ts` |
| agents | `GET /api/agents` | query by workspaceId/status | Conditional filter and default list | VERIFIED | `src/app/api/agents/__tests__/route.test.ts` |
| agents | `GET /api/agents/:id` | get | By path/query consistency | VERIFIED | `src/app/api/agents/[agentId]/__tests__/route.test.ts` |
| sessions | `GET /api/sessions/{id}` | state and lifecycle | Session not found/rename/disconnect/context behavior | VERIFIED | `src/app/api/sessions/[sessionId]/__tests__/route.test.ts` |
| sessions | `GET /api/sessions` | list/filter | Workspace + parent + limit filter | VERIFIED | `src/app/api/sessions/__tests__/route.test.ts` |
| sessions | `PATCH /api/sessions/{id}` | rename | Session not found returns 404 | VERIFIED | `src/app/api/sessions/[sessionId]/__tests__/route.test.ts` |
| sessions | `DELETE /api/sessions/{id}` | delete | Delete behavior and idempotency safety | VERIFIED | `src/app/api/sessions/[sessionId]/__tests__/route.test.ts` |
| sessions | `GET /api/sessions/{id}/history` | history + consolidation | Empty history and merge parameter behavior | VERIFIED | `src/app/api/sessions/[sessionId]/history/__tests__/route.test.ts` |
| sessions | `POST /api/sessions/{id}/disconnect` | lifecycle | Missing session returns 404 | VERIFIED | `src/app/api/sessions/[sessionId]/disconnect/__tests__/route.test.ts` |
| sessions | `GET /api/sessions/{id}/context` | context | Session topology query and missing handling | VERIFIED | `src/app/api/sessions/[sessionId]/context/__tests__/route.test.ts` |
| sessions | `POST /api/acp` (session/new) | teamChainId validation | Illegal value / non-team-agent-lead / child session carrying teamChainId all return -32602 | VERIFIED | `src/core/orchestration/__tests__/team-chain.test.ts` |
| sessions | `GET /api/sessions` / `GET /api/sessions/{id}` | teamChainId field | Explicit chain value returned as-is; default/legacy is null (interpreted as full_delivery) | VERIFIED | `src/app/api/sessions/__tests__/route.test.ts`, `src/app/api/sessions/[sessionId]/__tests__/route.test.ts` |
| health | `GET /api/health` | availability | Returns schema + readable status code | VERIFIED | `src/app/api/health/__tests__/route.test.ts` |

## Regression Checklist (mandatory)
- [ ] workspace-codebase-task cross-endpoint chain regression (state relationships before/after on the same workspace/task)
- [ ] Session state query consistency before/after task completion
- [ ] `agent` related delete/status change session hook regressions

## Negative Scenarios (at least one per endpoint)
- Path not found (404)
- Invalid request body (400)
- State conflict (409)
- Parameter out of range / type error (422)
- Concurrent/duplicate requests (idempotency or conflict)

## Execution Commands (fixed)
- `npm run api:check` — contract parity check
- `npm run api:test:schema` — OpenAPI schema validation suite

## Key Blocker Records
- If the environment is missing causing e2e to fail, mark as `BLOCKED: env`
- If the test file is reproducible but has timeout flakiness, mark as `BLOCKED: infra` with retry command

## Next Batch (examples)
- `POST /api/acp/install` / `DELETE /api/acp/install` full chain
- `GET /api/agents/{id}` + `PATCH /api/sessions/{id}`
- `/api/sessions` list/filter + polling heartbeat regression
