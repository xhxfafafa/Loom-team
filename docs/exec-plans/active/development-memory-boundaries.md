---
title: Development memory boundaries and runtime reclamation
status: proposed
date: 2026-08-10
scope: Next.js development server, Turbopack cache, ACP/Claude/MCP runtime lifecycle
---

# Development Memory Boundaries And Runtime Reclamation

## Problem Statement

During local development, the Routa Next.js process reached a 7.5 GiB physical
memory footprint (8.7 GiB peak). The host was also under severe memory pressure,
with compressed memory and swap in active use. This is not explained by normal
React rendering alone:

- the Next 16 development process uses the Turbopack path by default;
- `.next/dev/cache/turbopack` had grown to approximately 11 GiB and 1,625 files;
- active ACP sessions also left multiple Claude and MCP stdio-proxy processes
  running after work that appeared complete in the UI;
- previous MCP JSON parsing could grow the Node heap until it hit the configured
  4 GiB V8 limit. Request-size protections address that independent failure mode.

The goal is to make local development predictable on a 16 GiB machine without
deleting durable session history or breaking provider resume behavior.

## Scope

### In scope

1. Select a lower-risk default development bundler and retain Turbopack as an
   explicit opt-in.
2. Establish a safe, observable lifecycle for generated Next development cache.
3. Ensure an ACP session terminal event releases its Agent process and MCP proxy
   while retaining the durable session record, history, and traces.
4. Make memory cleanup report whether runtime processes were actually reclaimed.
5. Add focused tests for process release, non-release of active work, and
   recreation of a released session.

### Explicitly out of scope

- Rewriting the application away from Next.js, ACP, or MCP.
- Deleting user-created worktrees, databases, traces, or durable session history.
- Automatically killing processes solely because the host is under pressure,
  unless the session is already terminal or stale according to the policy below.
- Tuning browser, Docker Desktop, Codex, or unrelated application memory use.
- Treating a larger `--max-old-space-size` value as a memory optimization.

## Boundaries And Invariants

| Boundary | Required behavior | Must not happen |
|---|---|---|
| Development server | Default path stays usable and has a reproducible memory baseline. | A bundler choice silently changes production build behavior. |
| Generated cache | `.next` is disposable only while the dev server is stopped. | Cleanup removes source, `.routa` data, databases, worktrees, or user artifacts. |
| Terminal session | Persist history/trace before releasing runtime resources. | UI history disappears because a process is stopped. |
| Active session | Streaming, tool-use, timeout-pending, and child sessions with an active parent remain alive. | A long-running task is killed after an intermediate turn update. |
| Resume | A later prompt recreates a runtime from durable session metadata. | Runtime process identity is treated as durable state. |
| Observability | Cleanup distinguishes logical session removal from process termination. | A successful cleanup response masks unreclaimed Claude/proxy processes. |

## P0-1: Make Webpack The Default Development Bundler

### Rationale

The current high footprint is principally native/OS-accounted memory, not only
V8 heap. Turbopack is the leading suspect because the issue occurs on the Next
16 development path and its cache is abnormally large. Webpack provides a safe
control path while Turbopack remains available for dedicated testing.

### Planned change

- Change `npm run dev` to launch `next dev --webpack`.
- Add `npm run dev:turbopack` for the current default behavior.
- Keep build scripts unchanged; this work affects development mode only.
- Document the two commands and the intended comparison workflow.

### Acceptance criteria

- Both scripts start the application and API routes successfully.
- A clean 30-minute core-flow walkthrough in Webpack mode stays materially below
  the recorded 7.5 GiB Next-server footprint.
- A full page reload and a representative hot update work in both modes.
- Production and desktop build commands have no behavior change.

### Rollback

Restore `next dev` as the default script and retain the diagnostic command.

## P0-2: Bound The Development Cache Lifecycle

### Rationale

The Turbopack cache is generated state, but its size can hide or amplify a
development-server memory problem. A clear cleanup contract prevents accidental
deletion and makes cold-start comparisons repeatable.

### Planned change

- Add a `dev:clean` command that refuses to run when a Routa dev server is
  detected, then removes only the project `.next` directory.
- Add a lightweight `dev:diagnose` command or startup warning that reports the
  size of `.next/dev/cache/turbopack` and warns above an initial 2 GiB threshold.
- Document the required sequence: stop dev server → clean generated cache →
  restart the selected bundler.
- Do not auto-delete cache from `npm run dev`.

### Acceptance criteria

- Cache cleanup cannot target paths outside the repository `.next` directory.
- A running local dev server causes a clear, non-zero refusal rather than a
  partial cleanup.
- Fresh startup recreates all required generated files.
- Cache warning/diagnostics can be captured in a bug report without inspecting
  arbitrary user files.

### Rollback

Remove the new scripts and documentation; generated cache remains recreatable.

## P0-3: Release Agent And MCP Runtime On Session Terminal States

### Rationale

An ACP session owns short-lived runtime resources: a Claude/Codex/OpenCode
process, optional MCP stdio proxy, transports, SSE controllers, and in-memory
buffers. The current logical session cleanup path can remove records without
guaranteeing that its provider process is terminated. That leaves idle child
processes consuming memory and ports.

### Target lifecycle

```text
normal completion / explicit disconnect / delete / stale terminal cleanup
  -> persist history and trace
  -> mark terminal reason
  -> kill provider process or adapter
  -> wait for MCP proxy/transport shutdown
  -> clear transient buffers and SSE references
  -> retain durable session metadata for on-demand recreation
```

### Planned change

1. Introduce one service-level operation such as
   `finalizeSessionRuntime(sessionId, reason)`.
   - It persists required state before resource release.
   - It delegates process termination to `AcpProcessManager.killSession()`.
   - It records a structured release result: provider process, proxy, adapter,
     and cleanup errors.

2. Route every terminal path through it.
   - `POST /api/sessions/[sessionId]/disconnect`
   - `DELETE /api/sessions/[sessionId]`
   - Team Run deletion
   - stale-session cleanup and explicit memory cleanup
   - provider-reported normal completion, when the provider confirms no active
     work remains

3. Define provider-safe completion policy.
   - Release on a confirmed final state such as Claude `end_turn` or
     `stop_sequence`.
   - Do not release on `tool_use`, `max_tokens`, active streaming, pending
     timeout, or an active child/parent dependency.
   - Start with a feature flag for Claude process sessions, then expand only
     after provider-specific tests pass.

4. Preserve on-demand recreation.
   - A new prompt first reads durable session metadata.
   - Providers with native resume use it; providers without it receive the
     supported recovered Routa context and start a fresh runtime.
   - The UI must communicate any provider limitation rather than implying that
     the original OS process is still alive.

5. Upgrade memory cleanup reporting.
   - Return separate counts for logical sessions removed, provider processes
     terminated, MCP proxies closed, and failures.
   - Do not claim memory has been reclaimed when only message history was
     trimmed.

### Acceptance criteria

- A completed Claude session exits its child process and MCP proxy within a
  bounded grace period.
- Disconnect, delete, Team Run deletion, and stale cleanup terminate their
  owned runtime resources.
- A timeout-pending or tool-using session stays alive.
- Reopening a released session can create a usable provider runtime.
- Session history and traces survive runtime release.
- Tests assert process-manager calls and provider-policy exceptions; an
  integration test verifies the local process tree where the platform permits.

### Rollback

Gate automatic release behind a feature flag. Explicit disconnect/delete must
continue to reclaim resources even if automatic terminal release is disabled.

## Implementation Sequence

1. Establish baseline measurements: cold start, 30-minute core workflow,
   session fan-out, and post-cleanup process count for both bundlers.
2. Deliver P0-1 as an isolated script/documentation commit.
3. Deliver P0-2 as an isolated safe-cache-lifecycle commit.
4. Add lifecycle characterization tests before changing terminal cleanup.
5. Deliver P0-3 in two commits:
   - explicit disconnect/delete and cleanup reporting;
   - feature-flagged automatic completion release for Claude.
6. Run a 24-hour soak test with repeated create/complete/resume cycles.
7. Promote automatic release to additional providers only after their resume and
   task-dependency behavior are verified.

## Verification Matrix

| Scenario | Expected evidence |
|---|---|
| Webpack dev baseline | Next server footprint and core-page smoke output |
| Turbopack comparison | Same workload, cache size, footprint, and growth rate |
| Cache cleanup | Refusal while server runs; clean recreation after stop |
| Claude completion | Child and proxy exit; history remains readable |
| Claude follow-up | New runtime starts and receives the follow-up prompt |
| Tool-use / timeout | Process remains alive until terminal policy is satisfied |
| Explicit delete | No owned process survives; DB/history contract follows product policy |
| Memory API cleanup | Response distinguishes store cleanup from process cleanup |

## Success Metrics

- Webpack default development footprint remains below a documented baseline on
  the same workload and machine.
- Turbopack cache never grows unnoticed beyond the warning threshold.
- Zero orphan Claude/MCP proxy processes after completed, deleted, or stale
  sessions in the integration test suite.
- Memory cleanup reports process reclamation truthfully.
