---
title: Platforms Overview
hide_table_of_contents: true
---

# Platforms

Loom-team is a Web-only product. One Next.js backend serves the UI, the API, and the agent
runtime; you access it in the browser.

## Runtime Options

| Option | Best for | First action |
| --- | --- | --- |
| [Web — local development](/platforms/web) | contributors and first-time setup | `npm install --legacy-peer-deps && npm run dev` |
| [Web — self-hosted](/administration/self-hosting) | teams running Loom-team in their own environment | Docker or Node deployment |

## Product Semantics

However you run it, the important product ideas stay the same:

- work is scoped to a workspace
- providers execute sessions
- repositories are attached to workspaces
- Session, Kanban, and Team remain the core working modes

## Historical Note

Earlier editions of this product also shipped a packaged desktop app and a terminal CLI.
Both surfaces were removed in the Web-only migration; their Web-facing capabilities were
ported into the TypeScript backend. See
[the migration design doc](/design-docs) for the rationale.

## Read Next

- [Web](/platforms/web)
- [Configuration](/configuration) for providers and environment setup
- [Self-Hosting](/administration/self-hosting)
