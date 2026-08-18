---
title: "Team timeline does not refresh and follow newly rendered child content"
date: "2026-08-18"
kind: issue
status: resolved
resolved_at: "2026-08-18"
severity: medium
area: "team-ui"
tags: ["team", "timeline", "transcript", "refresh", "scroll", "sse", "web"]
reported_by: "human"
related_issues:
  - "2026-08-16-chat-transcript-auto-sync-gap.md"
github_issue: null
github_state: null
github_url: null
---

# Team 时间线不会自动刷新并跟随新增内容到底部

## What Happened

在 `/workspace/[workspaceId]/team/[sessionId]` 页面中，Team Lead 或子 Agent 已产生新的持久化记录，但页面可能需要点击顶部“刷新”才能显示。记录显示后，时间线也可能停留在旧位置，没有自动跟随新增内容到底部。

## Expected Behavior

- Team Lead 的实时消息应继续通过 SSE 立即显示。
- 根会话或子会话漏掉实时更新时，页面应在短时间内自动同步持久化 transcript。
- 用户原本位于底部时，Lead、子 Agent、工具结果或异步 Markdown 内容增长都应保持视口跟随到底部。
- 用户主动向上阅读历史内容时，不应被强制拉回底部。

## Reproduction Context

- Environment: web
- Route: `/workspace/default/team/<sessionId>`
- Trigger: Team Run 包含一个或多个子 Agent；子会话记录继续增长，或用户手动刷新 transcript
- Evidence: 用户截图显示 Team 时间线包含大量 Lead/成员结果，仍需手动刷新和滚动才能看到最新内容

## Why This Happens

1. Team 页面使用独立的 transcript 状态与 `SessionTimelineSection`，不经过普通 Session Chat 的 `useChatMessages` 自动同步逻辑。
2. Team transcript 只在初始化、descendant 列表变化、选定的根会话 SSE 结构事件或手动 Refresh 时加载，没有可见页面的周期兜底，也没有 focus/visibility 同步。
3. 当前滚动 effect 只依赖最新 Lead 消息的内容、ID 和 Lead 消息数量。子会话 lane 内容增长时，这些值可以全部保持不变。
4. 当前测试只覆盖首次恢复一条 Lead 消息后的滚动，没有覆盖子 lane 更新、异步内容高度变化或用户离开底部的行为。

## Relevant Files

- `src/app/workspace/[workspaceId]/team/[sessionId]/team-run-page-client.tsx`
- `src/app/workspace/[workspaceId]/team/[sessionId]/team-run-page-sections.tsx`
- `src/app/workspace/[workspaceId]/team/[sessionId]/__tests__/team-run-page-client.test.tsx`
- `src/app/workspace/[workspaceId]/team/[sessionId]/__tests__/team-run-page-sections.test.tsx`

## Implementation Specification

Follow `docs/design-docs/team-timeline-live-refresh-and-auto-follow.md`.

The implementation must solve both halves of the failure:

- visible-page transcript convergence for the root and all known descendants;
- rendered-height-driven bottom-follow with user scroll intent.

Do not mark this issue resolved after implementing only a timer or only a scroll effect.

## Verification Required

- Unit tests for periodic/focus refresh, hidden-page suppression, request coalescing, and stale root response protection.
- Unit tests for child-lane resize, pinned/unpinned scroll behavior, and cleanup.
- Manual browser verification on a live Team Run with child-session activity.

## References

- Design: `docs/design-docs/team-timeline-live-refresh-and-auto-follow.md`
- Related ordinary-chat issue: `docs/issues/2026-08-16-chat-transcript-auto-sync-gap.md`

## Resolution (2026-08-18)

Both halves of the failure are implemented per the design doc, in
`team-run-page-client.tsx` + `team-run-page-sections.tsx` (+ their tests).

Root causes and fixes:

1. No visible-page transcript convergence: added a 5s fallback interval that
   enqueues root + all known descendants through the existing
   `requestTranscriptRefresh` queue, gated on `document.visibilityState`, with
   immediate refresh on `visibilitychange` (to visible) and window `focus`.
   Interval/listeners are cleaned up on Team Run switch and unmount; poll
   targets follow the latest descendant list via a ref.
2. Polling could roll back live root SSE: added a monotonic root live-update
   generation captured at fetch start; if it changes before apply, the root
   snapshot in that round is skipped (never cleared) and a delayed convergence
   refresh is re-queued. Descendants still replace normally; no text dedupe.
3. Bonus defect fixed: `flushTranscriptRefresh` previously deleted transcript
   entries on fetch failure; failures now keep the last good snapshot.
4. Scroll follow keyed only on Lead messages: replaced with a pinned/unpinned
   model (48px threshold) driven by user scroll, initial pinned bottom scroll,
   and a ResizeObserver on a new `team-timeline-content` wrapper with a
   coalesced cancellable `requestAnimationFrame`. The section is remounted per
   run via `key={sessionId}` so switching restarts pinned.

Automated verification:

- `team-run-page-client.test.tsx`: 33/33 (8 new: visible polling of root +
  descendants, hidden suppression, visible/focus immediate refresh, in-flight
  coalescing, switch cleanup, stale-snapshot never erases SSE, convergence
  re-queue, failed refresh keeps messages).
- `team-run-page-sections.test.tsx`: 9/9 (explicit `ResizeObserver` mock,
  scrollTop assertions for pinned/unpinned/re-pin, thread-expand growth,
  coalesced frames, unmount cleanup).
- eslint on all four files: clean. `typecheck-smart`: pass.
- fitness fast tier: 100. fitness normal tier: no hard-gate/score block;
  remaining failures are pre-existing (repo-wide 63.3% coverage vs 80% gate,
  pre-existing 1868-line `team-run-page-client.tsx` budget violation, desktop
  shell checks, startup probe needing the removed Rust binary).
- `validate:web`: lint, tsc, schema, dependency-cruiser, full vitest (2791
  tests) all pass; `snapshots:validate` fails only on home/workspace/kanban/
  mcp-tools fixtures that do not include the Team page (pre-existing drift).

Manual browser verification on a live Team Run (12 children), no manual Refresh:

- Root + all descendants polled ~7× over ~32s while visible (5s interval).
- Initial load pinned at bottom (distance 0); scrolling far up preserved
  position across a polling round; scrolling back re-pinned.
- `focus` produced an immediate refresh within 1.2s; hidden simulation
  produced 0 polls over 7.5s and visible returned an immediate refresh.
- Real DOM growth while pinned was followed to the bottom (ResizeObserver +
  rAF); while unpinned the viewport did not move.
- Navigating away stopped all transcript polling (cleanup verified).
- Evidence: `/tmp/loom-team-verify/01-initial-load.png`,
  `/tmp/loom-team-verify/02-pinned-final.png`.
