---
title: Self-Hosting
---

# Self-Hosting

Loom-team is a Web-only product: one Next.js backend serves the UI, the API, and the agent
runtime. Self-hosting means running that web app in your own environment.

## What Self-Hosting Means Today

Self-hosting is about running the Next.js web surface, choosing a persistence mode (SQLite or
Postgres), and making sure the provider paths you rely on are available.

## Basic Local Flow

Run the web surface from source:

```bash
npm install --legacy-peer-deps
npm run dev
```

Open `http://localhost:3000`.

Local development uses SQLite by default (`ROUTA_DB_DRIVER=sqlite`), so no external database
is required.

## Production Deployment

Build the standalone output and run it behind your preferred hosting:

```bash
npm run build:docker
```

Docker Compose profiles cover SQLite and Postgres persistence. Set `DATABASE_URL` to use
Postgres in production; without it, the runtime falls back to SQLite or in-memory stores.

## Operational Concerns

The main things to think about are:

- which provider paths are available
- which environment variables are set
- whether agent runtimes (local CLIs or Docker-backed execution) are reachable from the host
- which persistence mode fits your durability needs

## What This Is Not Yet

The repository currently has stronger release and contributor docs than full public production
self-hosting runbooks. Treat this page as the operational entry point, not as a complete hosting
manual.

## Read Next

- [Configuration](/configuration)
- [Deployment](/deployment)
- [Release Guide](/release-guide)
