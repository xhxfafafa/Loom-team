---
title: Project Structure
---

# Project Structure

This page is for advanced users, self-hosters, and contributors who need to understand how the
different Loom-team runtime pieces fit together. If you are just trying to start using
Loom-team, go back to [Quick Start](/quick-start) or [Platforms](/platforms).

Loom-team is a workspace-first multi-agent coordination platform with a single runtime surface:

- `Web`: Next.js app and API in `src/`, with the TypeScript domain core in `src/core/`

This is the Web-only edition of the product. The former desktop shell and Rust backend were
removed; the Web-facing capabilities they provided now live in the TypeScript domain core.

## Main Paths

| Path | Purpose |
|---|---|
| `src/app/` | Next.js App Router pages and API routes |
| `src/client/` | Client components, hooks, and UI protocol helpers |
| `src/core/` | TypeScript domain logic, stores, ACP/MCP, Kanban, workflows, trace, review, fitness, and harness logic |
| `scripts/fitness/` | TypeScript fitness-function runners and gate helpers |
| `api-contract.yaml` | OpenAPI contract: single source of truth for the backend API |
| `docs/` | Canonical public docs, design docs, ADRs, release docs, and repository guidance |

## Canonical Docs

Use these files first when orienting yourself:

- [Architecture](/ARCHITECTURE): runtime topology and invariants
- [ADR Index](/adr): durable architectural decisions
- [Code Style](/coding-style): coding and testing conventions
- [Product Specs](/product-specs/FEATURE_TREE): generated route and endpoint inventory
- [Design Docs](/design-docs): normalized design intent and reviewed product decisions

## Reading Order

1. Read [Architecture](/ARCHITECTURE).
2. Read [ADR Index](/adr).
3. Read [Testing](/developer-guide/testing) to understand the validation model.
4. Read [Design Docs](/design-docs) when you need deeper intent, tradeoffs, or migration context.
