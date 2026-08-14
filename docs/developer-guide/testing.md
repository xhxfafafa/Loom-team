---
title: Testing
---

# Testing

Loom-team uses `npm run validate:web`, `npm run validate:web:e2e`, and the `docs/fitness/`
rulebook as the canonical validation system for source-code changes.

## Recommended Validation Flow

For source-code changes, use this order:

```bash
npm run validate:web
npm run validate:web:e2e
```

`validate:web` runs the static and unit-level gates: lint, typecheck, OpenAPI schema
validation, dependency rules, the vitest suite, and page-snapshot checks. `validate:web:e2e`
boots the Next.js app and runs the API contract suite and Playwright coverage.

## What The Gates Cover

- static: ESLint, TypeScript, dependency-cruiser rules, OpenAPI schema validation
- unit: vitest suites across `src/` and `scripts/`
- contract: `tests/api-contract/` executed against the running web backend
- end-to-end: Playwright specs under `e2e/`
- snapshots: page-snapshot validation for key product surfaces

Fitness tiers (`fast`, `normal`, `deep`) still organize the deeper evidence checks; the
aggregate gates wired into `validate:web` are the canonical entry point.

## UI And Runtime Checks

- Use Playwright for automated UI coverage.
- Use browser walkthroughs for smoke validation when the UI changes.
- For shell-level visual checks, run `npm run test:e2e:web-shell` against the web app.

## Docs-Only Changes

If the change is strictly non-code such as `docs/`, `*.md`, `*.yml`, or `.github/`, source-code
validation can be skipped.

## Canonical Rulebook

The full fitness-function and evidence model lives in the repository rulebook:

- [docs/fitness/README.md](https://github.com/xhxfafafa/Loom-team/blob/main/docs/fitness/README.md)
