---
title: Deployment Overview
---

# Deployment

Deployment in Loom-team covers one concern: running the Web runtime in your own environment.

Loom-team is Web-only. The earlier Desktop and CLI distribution channels (GitHub Release
downloads, npm/crates.io CLI packages) were removed in the Web-only migration; everything
ships as the Next.js web app.

## Deployment Paths

| Path | What it means today |
| --- | --- |
| Local development | `npm run dev` with SQLite, no external dependencies |
| Self-hosted deployment | Docker build (`npm run build:docker`) with SQLite or Postgres |

## Current Canonical Docs

- [Self-Hosting](/administration/self-hosting)
- [Release Guide](/release-guide)
- [Changelog](/getting-started/changelog)

## What This Covers Today

- running the web app in your own environment
- persistence choices (SQLite vs Postgres)
- release and versioning workflows for maintainers
