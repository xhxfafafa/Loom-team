---
slug: /
title: Loom-team
displayed_sidebar: docsSidebar
hide_table_of_contents: true
hide_title: true
---

<div className="routa-home">

<div className="routa-hero">
  <span className="routa-hero__eyebrow">Multi-Agent Coordination Platform</span>
  <h1 className="routa-hero__title">Loom-team</h1>
  <p className="routa-hero__lead">
    Workspace-first multi-agent coordination for real software delivery.
    Keep work attached to explicit product objects such as sessions, boards,
    specialists, and codebases instead of hiding everything inside one long-running chat.
  </p>
  <div className="routa-pills">
    <a className="routa-pill" href="/Loom-team/quick-start">Quick Start</a>
    <a className="routa-pill" href="/Loom-team/platforms/web">Web</a>
    <a className="routa-pill" href="/Loom-team/use-routa/common-workflows">Common Workflows</a>
  </div>
</div>

## Start In 5 Minutes

If you are evaluating Loom-team, do not start by reading everything. Pick one path and aim for
one real result:

<div className="routa-start-grid">
  <div className="routa-start-card">
    <span className="routa-start-card__badge">Recommended</span>
    <h3>Web — Local Development</h3>
    <p>Best for contributors and first-time setup: the full product surface in your browser.</p>
    <code>npm install --legacy-peer-deps && npm run dev</code>
    <p>Open <code>http://localhost:3000</code>, create a workspace, attach a repo, then start with a Session.</p>
    <a className="routa-inline-link" href="/Loom-team/platforms/web">Open Web Guide</a>
  </div>
  <div className="routa-start-card">
    <span className="routa-start-card__badge">Self-Hosted</span>
    <h3>Web — Deployment</h3>
    <p>Best for running Loom-team for your own team in your own environment.</p>
    <code>npm run build:docker</code>
    <p>Docker Compose profiles cover SQLite and Postgres persistence.</p>
    <a className="routa-inline-link" href="/Loom-team/administration/self-hosting">Open Self-Hosting Guide</a>
  </div>
</div>

## What You Can Do

<div className="routa-grid">
  <div className="routa-card routa-card--blue">
    <h3>Understand Codebases</h3>
    <p>
      Use Sessions to understand a new repository, inspect architecture, and recover work later
      from one main thread.
    </p>
  </div>
  <div className="routa-card routa-card--orange">
    <h3>Run Delivery Flow</h3>
    <p>
      Use Kanban when work needs explicit stages, specialist-by-lane automation, and review or
      done gates that actually enforce quality.
    </p>
  </div>
  <div className="routa-card routa-card--green">
    <h3>Coordinate Specialists</h3>
    <p>
      Use Team when the coordination problem is itself first-class and the work benefits from a
      lead dispatching child sessions across specialties.
    </p>
  </div>
</div>

## Documentation

<div className="routa-doc-map">
  <a href="/Loom-team/getting-started">
    <strong>Getting Started</strong>
    Read this after your first successful run to understand what "started" means.
  </a>
  <a href="/Loom-team/use-routa">
    <strong>Use Loom-team</strong>
    Learn what to do after setup: Sessions, Kanban, Team, and common workflows.
  </a>
  <a href="/Loom-team/developer-guide">
    <strong>Developer Guide</strong>
    Use this when you need configuration, hosting, testing, or deeper technical context.
  </a>
  <a href="/Loom-team/design-docs">
    <strong>Design Docs</strong>
    Read this only when you need design intent, invariants, or implementation reasoning.
  </a>
  <a href="/Loom-team/reference">
    <strong>Reference</strong>
    Lookup material for specialists, product specs, release process, and stable references.
  </a>
  <a href="/Loom-team/whats-new">
    <strong>What's New</strong>
    Recent release notes, changelog entry points, and current product updates.
  </a>
</div>

</div>
