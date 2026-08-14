---
title: Web
---

# Web

The web app is the product surface of Loom-team: a Next.js backend serves the UI, the API,
and the agent runtime, and you use it in the browser.

## When To Use Web

Always — Web is the only runtime surface. Typical setups:

- local development from source
- self-hosting for your own team
- internal deployment with Postgres persistence

## Run Locally

```bash
npm install --legacy-peer-deps
npm run dev
```

Open `http://localhost:3000`.

Local development uses SQLite by default (`ROUTA_DB_DRIVER=sqlite`), so no external
database is required for a first run. See
[Environment Variables](/configuration/environment-variables) for storage options.

## Production

For a production deployment, build the standalone output and run it behind your preferred
hosting:

```bash
npm run build:docker
```

Docker Compose profiles cover SQLite and Postgres; see
[Self-Hosting](/administration/self-hosting) and [Deployment](/deployment).

## Related Docs

- [Quick Start](/quick-start)
- [Administration](/administration)
- [Configuration](/configuration)
