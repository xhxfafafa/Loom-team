---
title: Team Timeline Live Refresh and Bottom Auto-Follow
status: accepted
purpose: Define reliable transcript refresh and bottom-follow behavior for the Web Team Run timeline without conflating it with the ordinary Session chat.
---

# Team Timeline Live Refresh and Bottom Auto-Follow

## Decision summary

The Team Run page must keep the visible Lead and child-session transcripts current without requiring the header Refresh button, and it must keep the timeline pinned to the newest rendered content while the user is already following the bottom.

Use the existing Team transcript refresh queue as a low-frequency fallback around the root-session SSE stream. Use DOM size observation for bottom-follow because Team timeline height can change when child lanes, expanded threads, Markdown, tool results, or pending questions render without changing the latest Team Lead message.

This design applies to:

```text
/workspace/[workspaceId]/team/[sessionId]
```

It does not change the ordinary Session chat implementation under `src/client/components/chat-panel/`.

## Problem

The Team Run timeline can show persisted records after a manual refresh but remain at an older scroll position. It can also remain stale until the user presses Refresh.

Two independent gaps combine into the visible failure:

1. **Refresh gap:** the Team page loads transcripts during bootstrap and refreshes descendants after selected root-session events, but it has no periodic visible-page fallback and no focus/visibility refresh. The page attaches the ACP live stream to the Team Lead, not to every descendant session.
2. **Scroll invalidation gap:** `SessionTimelineSection` scrolls after changes to the latest Lead message ID/content or Lead message count. Child-lane messages and other nested content can increase the timeline height while all three dependencies remain unchanged.

The existing unit test proves only initial restored-timeline scrolling. It does not reproduce child-lane growth or asynchronous layout changes.

## Evidence and current boundaries

Relevant production paths:

- `src/app/workspace/[workspaceId]/team/[sessionId]/team-run-page-client.tsx`
  - owns Team metadata, transcript state, ACP updates, refresh batching, and descendant-session discovery;
  - `fetchSessionTranscripts` currently replaces each fetched session's history and messages;
  - `requestTranscriptRefresh` and `flushTranscriptRefresh` already provide batching and in-flight coordination;
  - the root ACP stream updates only `messagesBySessionId[sessionId]` directly.
- `src/app/workspace/[workspaceId]/team/[sessionId]/team-run-page-sections.tsx`
  - owns the actual `overflow-y-auto` timeline element;
  - renders child `SessionLaneItem.messages` inside a Lead tool-call thread;
  - currently performs one `requestAnimationFrame` scroll keyed only by Lead-message fields.
- `src/app/workspace/[workspaceId]/team/[sessionId]/__tests__/team-run-page-client.test.tsx`
  - should characterize polling, visibility, batching, and stale-response protection.
- `src/app/workspace/[workspaceId]/team/[sessionId]/__tests__/team-run-page-sections.test.tsx`
  - should characterize bottom-follow behavior and user scroll intent.

The ordinary chat fallback in `src/client/components/chat-panel/hooks/use-chat-messages.ts` is reference behavior only. Do not make the Team page depend on that hook: the Team page owns multiple related transcripts and a different presentation model.

## Required behavior

### 1. Live data remains SSE-first

- Keep root Team Lead ACP updates as the primary low-latency path.
- Do not replace SSE with high-frequency polling.
- Do not open one permanent ACP/SSE connection per child session solely for this UI.

### 2. Visible-page transcript fallback

While the Team Run page is visible:

- request a refresh for the root session and all currently known descendant sessions every 5 seconds;
- use the existing `requestTranscriptRefresh` queue rather than calling the API independently from the timer;
- coalesce duplicate session IDs and preserve the existing in-flight behavior;
- when the document becomes visible or the window receives focus, request one immediate refresh;
- perform no periodic transcript requests while `document.visibilityState === "hidden"`;
- clear interval and event listeners when the Team Run changes or the component unmounts;
- when descendant membership changes, the next refresh set must use the new session IDs without leaking timers from the prior Team Run.

The interval is a correctness fallback, not a guarantee that every UI update waits five seconds. Root SSE updates should continue to render immediately.

### 3. Prevent a polling response from rolling back live root messages

Periodic fetching introduces a race that the current manual/bootstrap refresh rarely exposes:

```text
start root transcript fetch
  -> receive and render a newer root SSE chunk
  -> older fetch resolves
  -> snapshot replacement erases the newer chunk
```

The implementation must guard this race. A recommended minimal approach is:

1. Maintain a monotonically increasing live-update generation for the root session.
2. Capture that generation when a root transcript request starts.
3. If the generation changed before the response is applied, do not replace the root session with that response.
4. Queue another root transcript refresh so durable state can converge after the live burst.
5. Descendant snapshots may still use replacement semantics because those sessions are not being appended through the selected root ACP stream.

An equivalent sequence/version comparison is acceptable if the transcript API already exposes a reliable ordering token. Do not deduplicate by message text.

### 4. Bottom-follow is based on user intent

Use the following state model for the timeline scroll region:

- **Pinned:** the user is at or within 48 px of the bottom. New rendered content keeps the timeline at the bottom.
- **Unpinned:** the user has scrolled farther than 48 px from the bottom. New content must not pull the user away from older records.
- Initial hydration and Team Run switching start pinned and scroll to the bottom after content lays out.
- Scrolling back within the threshold restores pinned mode.

The bottom distance is:

```ts
scrollHeight - scrollTop - clientHeight
```

Do not infer pinned state only from message count.

### 5. Observe actual rendered height

Add a content wrapper inside the existing timeline scroll region and observe it with `ResizeObserver`.

When its rendered height changes:

- if pinned, schedule a single `requestAnimationFrame` and set the scroll region to its current `scrollHeight`;
- if unpinned, preserve the current scroll position;
- cancel a pending frame before scheduling a replacement;
- disconnect the observer and cancel the frame during cleanup.

This must cover:

- a new Lead message;
- a child lane receiving new messages while the latest Lead message is unchanged;
- expanding or collapsing a child thread;
- pending-question UI appearing;
- Markdown/tool content changing height after the React commit.

`ResizeObserver` is preferred over adding every nested data structure to a React dependency list. The product requirement concerns rendered height, and asynchronous Markdown/layout changes are not fully represented by React message-count dependencies.

### 6. Preserve explicit manual refresh

Keep the header Refresh button. It should continue to request metadata plus root and descendant transcripts immediately. Manual refresh must use the same queued refresh path and stale-root-response protection as automatic refresh.

## Implementation constraints

- Use `desktopAwareFetch` and existing API path conventions; do not add direct `fetch('/api/...')` calls.
- Keep the top-level Team page as an orchestration shell. Small scroll-state logic belongs in `SessionTimelineSection` or a focused Team timeline hook if extraction materially improves testability.
- Do not introduce a generic polling framework for this change.
- Do not change persistence, ACP protocol, session identity, runtime ownership, or recovery semantics.
- Do not clear currently rendered messages when a refresh fails. Preserve the last good snapshot and retry on the next trigger.
- Do not add hardcoded user-facing strings. Any new status or “new messages” UI must use i18n.
- Avoid a continuous `MutationObserver` over the entire page; observe only the timeline content element.

## Recommended implementation sequence

1. Add failing Team page-client tests for visible polling, hidden-page suppression, focus refresh, and root live-update race protection.
2. Add failing timeline-section tests for child-lane growth and pinned/unpinned behavior.
3. Extend the existing transcript refresh queue with root generation protection.
4. Add the visible-page interval and focus/visibility triggers using the queue.
5. Replace the Lead-message-only scroll effect with scroll-intent tracking plus `ResizeObserver`.
6. Run targeted tests, ESLint, TypeScript checking, and the repository fast/normal fitness gates.
7. Perform a manual browser walkthrough on a Team Run with at least one active child session.

## Test matrix

### Team page client

1. Initial resolved Team Run requests root and descendant transcripts.
2. A visible page requests the current root and descendants after 5 seconds.
3. A hidden page does not issue the periodic request.
4. Returning to visible or focusing the window requests an immediate refresh.
5. Repeated timer/focus triggers coalesce while a transcript request is in flight.
6. Changing Team Runs cleans up the old timer and refreshes only the new run's IDs.
7. A root SSE update received after a transcript request begins is not erased by the older response.
8. A skipped stale root response queues a later convergence refresh.
9. A failed automatic refresh preserves the last successfully rendered messages.

### Timeline section

1. Initial hydration scrolls to `scrollHeight` after layout.
2. A new Lead message scrolls when pinned.
3. Updating only a child lane causes a content resize and scrolls when pinned.
4. An asynchronous content-height change triggers the same behavior.
5. Scrolling more than 48 px from the bottom unpins the timeline.
6. Content growth while unpinned preserves `scrollTop`.
7. Scrolling back near the bottom re-enables following.
8. Observer, event listener, and animation-frame cleanup run on unmount.

Mock `ResizeObserver` explicitly in unit tests. Do not assert only that `scrollIntoView` was called; assert the scroll-region state or `scrollTop` outcome.

## Manual acceptance walkthrough

Use a real Team Run route with a Lead and at least one delegated child session:

1. Open `/workspace/<workspaceId>/team/<sessionId>` and do not press Refresh.
2. Keep the timeline at the bottom while the Lead and child produce messages.
3. Verify root messages appear immediately and descendant records converge within the fallback interval.
4. Verify the viewport stays at the newest rendered content as a child result block grows.
5. Scroll upward several records and wait for new activity; verify the viewport does not jump.
6. Scroll back to the bottom; verify following resumes.
7. Hide the tab for more than one interval; verify no polling occurs while hidden and one refresh occurs after returning.
8. Confirm the header Refresh button still updates metadata and all known transcripts.

## Definition of done

- The Team timeline no longer requires manual refresh to converge on persisted root or child records.
- When the user is following the bottom, newly rendered Team content remains visible without manual scrolling.
- When the user is reading older records, automatic updates do not steal their scroll position.
- Polling cannot roll back a newer root SSE message.
- Targeted tests cover both the refresh and rendered-height failure modes.
- `npm run fitness:run -- --tier fast --scope local --min-score 0` passes.
- `npm run fitness:run -- --tier normal --scope local --min-score 0` passes.
- `npm run validate:web` passes before publishing.

## Related records

- `docs/issues/2026-08-18-team-timeline-refresh-and-bottom-follow-gap.md`
- `docs/issues/2026-08-16-chat-transcript-auto-sync-gap.md` — ordinary Session chat only; not the Team implementation.
