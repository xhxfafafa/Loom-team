---
title: Environment Variables
---

# Environment Variables

The most relevant environment variables exposed by the current codebase are:

```bash
ROUTA_DB_DRIVER=sqlite
ROUTA_DB_PATH=...
DATABASE_URL=...
OPENCODE_SERVER_URL=...
OPENCODE_API_KEY=...
ANTHROPIC_API_KEY=...
ANTHROPIC_AUTH_TOKEN=...
OPENAI_API_KEY=...
ATLASCLOUD_API_KEY=...
ATLASCLOUD_API_BASE=https://api.atlascloud.ai/v1
CODEX_API_KEY=...
```

## What They Affect

- `ROUTA_DB_DRIVER` / `ROUTA_DB_PATH`: selects the SQLite driver and database file location for local-first development
- `DATABASE_URL`: switches persistence to Postgres for production deployments
- `OPENCODE_SERVER_URL` / `OPENCODE_API_KEY`: enables OpenCode SDK-backed execution
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`: enables Anthropic-backed execution paths
- `OPENAI_API_KEY`: enables OpenAI-backed model usage where supported
- `ATLASCLOUD_API_KEY`: enables Atlas Cloud when `WORKSPACE_AGENT_PROVIDER=atlascloud` or a model alias uses `https://api.atlascloud.ai/v1`
- `ATLASCLOUD_API_BASE`: optional Atlas Cloud OpenAI-compatible base URL override
- `CODEX_API_KEY`: enables Codex-backed flows where supported

## Practical Rule

Only set what matches the provider path you actually use. For most first runs:

- `npm run dev` already starts with SQLite (`ROUTA_DB_DRIVER=sqlite`), so no storage variables are needed
- add one provider credential (for example `ANTHROPIC_API_KEY`) to enable execution
- set `DATABASE_URL` only when deploying with Postgres

## Naming Note

Environment variables keep the historical `ROUTA_` prefix. The Web-only migration intentionally
did not mass-rename internal identifiers (environment variable names, some internal keys);
a full brand rename is a separate, later phase.
