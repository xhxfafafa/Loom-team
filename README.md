<div align="center">

<img src="public/logo-animated.svg" alt="Loom-team" width="360" />

# Loom-team

**Workspace-first multi-agent coordination platform for software delivery (Web-only)**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16.2-black.svg)](https://nextjs.org/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[Demo](#demo) • [Architecture](#architecture) • [How It Works](#how-it-works) • [Why Loom-team](#why-loom-team) • [Quick Start](#quick-start) • [Docs](#docs) • [中文](README.zh-CN.md)

</div>

---

Loom-team is a workspace-first multi-agent coordination platform for software delivery. It keeps goals, tasks, sessions, traces, evidence, and review state visible on a board instead of burying them inside a single chat thread.

This repository is the Web-only edition of the product: a single Next.js backend serves the UI, the API, and the agent runtime. The former Tauri desktop shell and the Rust backend crates have been removed; their Web-facing capabilities were ported to TypeScript/Node.

[Architecture](docs/ARCHITECTURE.md) · [Feature Tree](docs/product-specs/FEATURE_TREE.md) · [Quick Start](docs/quick-start.md) · [Contributing](CONTRIBUTING.md)

## Demo

- [Bilibili walkthrough](https://www.bilibili.com/video/BV16CwyzUED5/)
- [YouTube walkthrough](https://www.youtube.com/watch?v=spjmr_1AQLM)

![Loom-team Kanban Overview](https://github.com/user-attachments/assets/8fdf7934-f8ba-469f-a8b8-70e215637a45)

## Architecture

### System Architecture

![Loom-team architecture](docs/architecture.svg)

The implementation is a single-backend Web product.

- Web: Next.js pages and route handlers in `src/`, backed by the TypeScript domain core in `src/core/`
- Storage: SQLite for local-first development, Postgres for production deployment
- Contract: `api-contract.yaml` is the single source of truth for every endpoint the backend exposes
- Integration surfaces: ACP, MCP, A2UI, REST, and SSE

> Note: internal identifiers (environment variable prefix `ROUTA_`, some component and key names)
> are intentionally unchanged in this edition. A full brand rename is a separate, later phase.

### Review Gate Architecture

![Loom-team review gate](docs/review-gate.svg)

The delivery gate is a stacked decision path, not a single reviewer persona.

- Harness traces answer what happened by surfacing traces, changed files, commands, git state, and attribution
- Fitness functions answer what should be true by enforcing hard gates, evidence requirements, and file budget or policy checks (TypeScript fitness engine under `scripts/fitness/` and `src/core/fitness/`)
- Gate Specialist answers whether the card can move by verifying acceptance criteria and routing to Done, Dev, or human escalation

## How It Works

```text
You: "Build a user auth system with login, registration, and password reset"
                                                            ↓
                                    Workspace + Kanban Board
                                                            ↓
 Backlog              Todo              Dev               Review            Done
 Backlog Refiner  ->  Todo Orchestrator -> Dev Crafter -> Review Guard -> Done Reporter
                                                            ↘
                                                                Blocked Resolver
```

Loom-team treats the board as both the planning surface and the coordination bus. The important detail is that each lane is backed by a different specialist prompt, and each downstream lane is deliberately stricter than the previous one.

At a high level, two specialist layers work together:

- Core roles: ROUTA coordinates, CRAFTER implements, GATE verifies
- Kanban lane specialists: each column applies a concrete prompt contract and a concrete evidence contract

### End-to-End Example

1. You describe a goal in natural language.
2. ROUTA or the board automation turns that goal into a workspace-scoped card.
3. Backlog Refiner rewrites the rough request into a canonical YAML story with acceptance criteria, constraints, dependencies, and an INVEST snapshot.
4. Todo Orchestrator distrusts that upstream card, reparses the YAML, rejects weak stories, and appends an execution-ready brief.
5. Dev Crafter distrusts the plan again, refuses to code unless the story is executable, implements only the scoped change, runs validation, commits the work, and appends Dev Evidence.
6. Review Guard distrusts Dev's self-assessment, independently checks each acceptance criterion, requires tests and a clean git state, and either rejects to Dev or approves to Done.
7. Done Reporter appends a short completion summary that explains what shipped and what evidence justified completion.
8. If the work is blocked by environment, dependency, or ambiguity, Blocked Resolver writes down the blocker and routes the card back to the correct lane instead of letting the problem stay implicit.

### Lane Contracts

| Lane | Specialist | What the prompt enforces | What gets written to the card | Typical handoff |
| --- | --- | --- | --- | --- |
| Backlog | Backlog Refiner | Clarify scope, do not code, and do not move forward until the card contains exactly one canonical YAML story block | Canonical YAML story with problem statement, acceptance criteria, constraints, dependencies, out-of-scope items, and INVEST checks | Move to Todo only when the story parses and is independently executable |
| Todo | Todo Orchestrator | Re-validate Backlog output, reject malformed or vague cards, and turn a valid story into an execution-ready brief | Execution Plan, Key Files and Entry Points, Dependency Plan, Risk Notes | Move to Dev only when implementation can start within minutes |
| Dev | Dev Crafter | Re-check that the card is executable, implement only the scoped change, run verification, commit the work, and keep git clean | Dev Evidence with changed files, work summary, tests run, per-AC verification, caveats | Move to Review only after commit exists and the worktree is clean |
| Review | Review Guard | Independently verify every acceptance criterion, reject missing evidence, reject scope creep, reject dirty git state, reject broken lint or type checks | Review Findings with verdict, per-AC status, issues found, reviewer notes | Move to Done only with APPROVED verdict |
| Done | Done Reporter | Treat Done as terminal, do not advance further, and leave behind a concise completion record | Completion Summary with what shipped, key evidence, and completion date | Stay in Done |
| Blocked | Blocked Resolver | Classify the blocker, explain root cause, and route back only when there is a concrete next step | Blocker Analysis with blocker type, root cause, resolution, and routing decision | Return to Backlog, Todo, Dev, Review, or remain Blocked |

### Card Artifacts Grow As The Work Moves Forward

The same card becomes stricter over time:

- Backlog produces the canonical story YAML
- Todo adds the execution brief
- Dev adds evidence of implementation and verification
- Review adds a formal verdict and findings
- Done adds a completion summary

This is why the board is not just visual status. Each column changes what the next specialist is allowed to trust.

### Core Specialist Prompts Under The Board

- ROUTA Coordinator: plans first, never edits files directly, writes the spec, waits for approval, delegates work in waves, and calls GATE for verification after implementation.
- CRAFTER Implementor: stays within task scope, avoids refactors and scope creep, coordinates with other agents when files overlap, runs the verification steps it was given, and commits in small units.
- GATE Verifier: verifies against acceptance criteria only, treats evidence as mandatory, does not allow partial approval, and reports explicit verdicts instead of vague confidence.

The built-in lane prompts live under `resources/specialists/workflows/kanban/*.yaml`, and the core role prompts live under `resources/specialists/core/{routa,crafter,gate}.yaml`.

## Why Loom-team

Single-agent chat works for isolated tasks. It breaks down when the same thread has to do decomposition, implementation, review, evidence collection, and release decisions.

Loom-team makes those responsibilities explicit:

- Work starts from a workspace, not hidden global repo state
- Kanban lanes route work between specialists instead of mixing every role into one prompt
- Sessions, traces, notes, artifacts, codebases, and worktrees are durable objects
- Provider runtimes are normalized through adapters instead of leaking provider-specific behavior into the product
- The review boundary is a real gate, not just another opinionated reviewer

## What You Can Do Today

- Create workspace-scoped overviews, Kanban boards, sessions, team views, and codebase views
- Run agent sessions with create, prompt, cancel, reconnect, streaming, and trace inspection flows
- Route work across specialist lanes with queueing and per-board automation
- Manage local repositories, worktrees, file search, Git refs, and commit inspection
- Import GitHub repositories as virtual workspaces and browse trees, files, issues, PRs, and comments
- Add MCP tools and custom MCP servers
- Use schedules, webhooks, background tasks, and workflow runs for automation beyond one-off prompts
- Review changes with findings, severity, traces, harness signals, and fitness reports
- Run the product as a self-hosted web app, local-first with SQLite or production-grade with Postgres

## Quick Start

Loom-team runs entirely in the browser against a self-hosted Next.js backend.

```bash
npm install --legacy-peer-deps
npm run dev
```

Open `http://localhost:3000`.

`npm run dev` starts the Webpack dev server (the lower-risk default for memory
behavior). `npm run dev:turbopack` keeps the Turbopack dev server available for
dedicated comparison and testing. Production builds are unaffected.

The Next dev cache (`.next/`) is disposable generated state, but it must only
be removed while no dev server is running:

1. Stop the running dev server.
2. Run `npm run dev:clean` — it refuses with a clear error while a dev
   server is detected, then removes only the repository `.next` directory.
3. Restart the selected bundler (`npm run dev` or `npm run dev:turbopack`).

Run `npm run dev:diagnose` to report the `.next` cache size; it warns when the
Turbopack dev cache (`.next/dev/cache/turbopack`) grows past 2 GiB. Capture its
output in bug reports instead of inspecting arbitrary local files.

Then:

1. Create a workspace.
2. Enable one provider.
3. Attach a repository.
4. Start from Session for ad hoc work, or Kanban for routed delivery.

For deployment, environment variables, and provider configuration see
[docs/administration/self-hosting.md](docs/administration/self-hosting.md),
[docs/deployment/index.md](docs/deployment/index.md), and
[docs/configuration/environment-variables.md](docs/configuration/environment-variables.md).

## Develop From Source

### Web runtime

```bash
npm install --legacy-peer-deps
npm run dev
```

### Docker

```bash
docker compose up --build
docker compose --profile postgres up --build
```

The Docker image builds the standalone Next.js output (`ROUTA_WEB_STANDALONE=1`)
and serves the same web surface.

## Validation

Use [docs/fitness/README.md](docs/fitness/README.md) as the canonical validation rulebook.
The Web-only aggregate gates are:

```bash
npm run validate:web        # lint, tsc, api schema, dependency-cruiser, vitest, snapshots, build
npm run validate:web:e2e    # contract tests + Team/Kanban Playwright specs against a test server
npm run test
npm run test:e2e
npm run api:test:nextjs
npm run lint
```

## Repository Map

| Path | Purpose |
| --- | --- |
| `src/app/` | Next.js App Router pages and API routes |
| `src/client/` | Client components, hooks, view models, and UI protocol helpers |
| `src/core/` | TypeScript domain services for ACP/MCP, Kanban, workflows, traces, review, harness, fitness, and stores |
| `scripts/fitness/` | TypeScript fitness-function runners and gate helpers |
| `api-contract.yaml` | OpenAPI contract: single source of truth for the backend API |
| `docs/ARCHITECTURE.md` | Canonical architecture boundaries and invariants |
| `docs/adr/` | Architecture decision records |
| `docs/product-specs/FEATURE_TREE.md` | Generated route and endpoint inventory |
| `docs/fitness/` | Validation and quality gates |

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [ADR Index](docs/adr/README.md)
- [Quick Start](docs/quick-start.md)
- [Feature Tree](docs/product-specs/FEATURE_TREE.md)
- [Fitness Rules](docs/fitness/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## License

MIT. See [LICENSE](LICENSE).
