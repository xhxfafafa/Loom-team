# Loom-team Release Guide

This guide covers the process for releasing new versions of Loom-team. Loom-team is Web-only:
a release is a git tag plus release notes, and deployments use the Docker build of the
Next.js web app. The earlier crates.io, npm CLI, and Desktop distribution channels were
removed in the Web-only migration.

## Overview

The release process publishes two things:

1. **Git tag + GitHub Release** — the version marker and user-facing release notes
2. **Docker build** — the deployable web app (`npm run build:docker`)

## Prerequisites

- `main` is green: `npm run validate:web` and `npm run validate:web:e2e` pass
- No uncommitted changes
- Docker available if you intend to verify the production build

## Release Steps

```bash
# 1. Ensure you're on main with the latest code
git checkout main
git pull origin main

# 2. Run the validation gates
npm run validate:web
npm run validate:web:e2e

# 3. Bump the version in package.json (semver)
npm version patch --no-git-tag-version   # or minor / major

# 4. Commit and tag
git add package.json package-lock.json
git commit -m "chore: release vX.Y.Z"
git tag vX.Y.Z

# 5. Push
git push origin main --tags
```

Then create a GitHub Release for the tag at
[github.com/xhxfafafa/Loom-team](https://github.com/xhxfafafa/Loom-team/releases) with a
short, user-facing summary of the changes.

## Deploying A Release

Deployments build the standalone web output:

```bash
npm run build:docker
```

See [Self-Hosting](/administration/self-hosting) and [Deployment](/deployment) for
persistence options (SQLite vs Postgres) and operational concerns.

## Version Bump Types

Follow [Semantic Versioning](https://semver.org/):

- **Patch** (0.2.4 → 0.2.5): Bug fixes, no breaking changes
- **Minor** (0.2.5 → 0.3.0): New features, backward compatible
- **Major** (0.3.0 → 1.0.0): Breaking changes

## Rollback

If you need to roll back a release:

```bash
# Delete the tag locally and remotely
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z

# Delete the GitHub Release created for the tag
```

For deployments, redeploy the previous tag's Docker build.

## Historical Note

Releases before the Web-only migration also published Rust crates to crates.io, CLI
packages to npm, and Desktop installers through GitHub Releases. Those channels and their
workflows (`release.yml`, `cargo-release.yml`, `cli-release.yml`, `tauri-release.yml`) were
removed together with the desktop shell and Rust backend; their setup docs
(`RELEASE_SETUP.md`, `RELEASE_CHECKLIST.md`) were removed with them.

## Related Documentation

- [Self-Hosting](/administration/self-hosting)
- [Deployment](/deployment)
- [Testing](/developer-guide/testing) for the validation gates
