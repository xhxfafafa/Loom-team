---
title: Quick Start
sidebar_position: 2
---

# Quick Start

Loom-team is a Web-only product. One Next.js backend serves the UI, the API, and the agent
runtime, and you use it in the browser.

If you only want the shortest path to “Loom-team is running and useful”, run the web app
locally.

## First Success Checklist

The right goal for your first 5 minutes is not “understand all of Loom-team”. It is:

1. start the web app
2. make one provider available
3. point Loom-team at a real repository
4. get one useful answer or plan back

## Run Locally

```bash
npm install --legacy-peer-deps
npm run dev
```

Open `http://localhost:3000`.

Local development uses SQLite by default (`ROUTA_DB_DRIVER=sqlite`), so no external database
is required for a first run. See
[Environment Variables](/configuration/environment-variables) for storage options.

### First Run

After the app opens:

1. Create a workspace.
2. Open `Providers` and make one provider available.
3. Attach a local repository or clone one from GitHub.
4. Start with `Session` and ask Loom-team to inspect or plan work in your repository.
5. Move to `Kanban` when you want decomposition and lane automation.

## Self-Hosted

For running Loom-team for your own team, build the standalone output and deploy it behind
your preferred hosting:

```bash
npm run build:docker
```

Docker Compose profiles cover SQLite and Postgres persistence. See
[Self-Hosting](/administration/self-hosting) and [Deployment](/deployment) for details.

## Recommendation

- local development: `npm run dev` with SQLite
- team or production deployment: Docker build with Postgres

## What To Read Next

Pick the next page based on what you are trying to do:

- [Use Loom-team](./use-routa) if setup is done and you want workflows
- [Configuration](./configuration) if models or providers are not ready yet
- [Platforms](./platforms) for the Web runtime surface and deployment options
- [Use Loom-team — Common Workflows](./use-routa/common-workflows) if you want examples rather than concepts
- [What's New](./whats-new) if you are evaluating recent changes

## Next Steps

After Quick Start:

- read [Use Loom-team](./use-routa)
- read [Configuration](./configuration)
- read [Self-Hosting](./administration/self-hosting) if you plan to deploy
- read [What's New](./whats-new)
