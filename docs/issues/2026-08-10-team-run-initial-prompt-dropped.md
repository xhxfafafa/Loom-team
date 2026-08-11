---
title: Team run initial prompt can be dropped before the lead session is selected
date: "2026-08-10"
status: resolved
kind: issue
area: "team"
created_at: 2026-08-10
updated_at: 2026-08-10
---

# Team run initial prompt can be dropped before the lead session is selected

## What happened

A newly created Team run displayed its Agent Lead as `WORKING`, but its task tree stayed empty and no specialist sessions were created. The persisted root session had `first_prompt_sent = 0` and an empty history even though the pending prompt was no longer present in browser session storage.

## Why it mattered

The run looked active while no model work was occurring. Running another Team at the same time was unrelated, but the misleading state made the failure resemble a concurrency limit.

## Root cause

The Team run page consumed the navigation-scoped pending prompt as soon as ACP reported a generic ready update. It did not first verify that the hook's active session was the Team run named in the route. The current-session prompt helper could therefore return before a session was selected, while the page permanently marked the prompt as sent.

## Resolution

- Wait until both the loaded Team metadata and the ACP hook are bound to the route session before consuming the pending prompt.
- Send through the explicit-session prompt API rather than the current-session API.
- Track in-flight delivery separately and mark the prompt sent only after the delivery promise completes.
- Add a regression test covering the delayed session-selection race.

## Verification

- Focused Team run page tests cover the prompt-selection race.
- Repository fitness validation is run before publishing the fix.
