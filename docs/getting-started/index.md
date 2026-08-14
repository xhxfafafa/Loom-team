---
title: Getting Started Overview
hide_table_of_contents: true
---

# Getting Started

This section is for the first 10 minutes with Loom-team: what it is, how to run it, and
what "working" should look like after setup.

## Run Loom-team

Loom-team is a Web-only product: one Next.js backend serves the UI, the API, and the agent
runtime.

<div className="routa-doc-map">
  <a href="/Loom-team/platforms/web">
    <strong>Web — Local Development</strong>
    Run from source with <code>npm run dev</code> and open <code>http://localhost:3000</code>.
    Uses SQLite by default, so no external database is needed.
  </a>
  <a href="/Loom-team/administration/self-hosting">
    <strong>Web — Self-Hosted</strong>
    Deploy the Docker build for your own team, with SQLite or Postgres persistence.
  </a>
</div>

If you only want the shortest path to a successful first run, start with [Quick Start](/quick-start).

## What To Do First

Do not try to learn the whole product on day one. Reach one useful outcome first:

<div className="routa-start-grid">
  <div className="routa-start-card">
    <span className="routa-start-card__badge">Step 1</span>
    <h3>Start The Web App</h3>
    <p>Run Loom-team locally with <code>npm run dev</code>, or deploy the Docker build.</p>
    <a className="routa-inline-link" href="/Loom-team/quick-start">Open Quick Start</a>
  </div>
  <div className="routa-start-card">
    <span className="routa-start-card__badge">Step 2</span>
    <h3>Enable One Provider</h3>
    <p>You only need one working provider and one valid model path to get moving.</p>
    <a className="routa-inline-link" href="/Loom-team/configuration">Open Configuration</a>
  </div>
  <div className="routa-start-card">
    <span className="routa-start-card__badge">Step 3</span>
    <h3>Run Against A Real Repo</h3>
    <p>Attach a codebase or open a repository, then start with a Session.</p>
    <a className="routa-inline-link" href="/Loom-team/use-routa">Open Use Loom-team</a>
  </div>
</div>

## Recommended Reading Order

1. Read [Quick Start](/quick-start) for the Web run path.
2. Follow the [Web platform page](/platforms/web) for run and deployment steps.
3. Open [Configuration](/configuration) if you still need a provider or model.
4. Read [Core Concepts](/core-concepts) once the product is already running.

## What "Started" Means In Loom-team

You are successfully onboarded once you can do all of the following:

- create or enter a workspace
- make one provider available
- attach a repository
- launch either a `Session`, `Kanban` flow, or `Team` run

## Entry Points In This Section

- [Quick Start](/quick-start): fast install and first-run path
- [Changelog](/getting-started/changelog): release notes and release history entry points
- [Platforms](/platforms): the Web-only runtime surface
