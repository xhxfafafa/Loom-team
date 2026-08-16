---
status: ready_for_implementation
purpose: Allow users to attach bounded local text files and images when sending follow-up prompts to the Team Lead in an existing Team Run.
related_design:
  - ../../design-docs/kanban-task-input-attachments.md
---

# Team Run Follow-up Attachments

## Status

Ready for implementation. This document is the handoff contract for the implementing Agent. It
does not include source-code changes.

## Problem

Users frequently need to add screenshots, logs, specifications, or other context after a Team Run
has already started. The current Team Run timeline composer cannot attach a local file, even though
the shared composer already contains a bounded attachment picker.

The current behavior is caused by two explicit implementation boundaries:

- `TiptapInput.attachmentsEnabled` defaults to `false` and is currently described as a capability
  available only during Team launch.
- `team/[sessionId]/team-run-page-client.tsx` renders `TiptapInput` without attachment props and its
  `onSend` callback discards `InputContext`, so a follow-up prompt can send only plain text.

The placeholder is also misleading. `@` searches files already present in the selected repository;
it does not open a local file picker. Local files must continue to use the explicit paperclip
control.

## Goal

Allow a user on an existing Team Run page to:

1. select or drag supported local files into the timeline composer;
2. see and remove selected files before sending;
3. send the text, repository file references, and local attachments atomically to the Team Lead;
4. keep the complete draft when preparation, recovery, capability validation, or prompt delivery
   fails; and
5. retry an unchanged failed submission without creating a duplicate provider turn.

## Non-goals

This change does not add:

- a generic upload API or multipart endpoint;
- a database table, object-storage service, or persistent Team file library;
- Task or Artifact records for follow-up attachments;
- attachment previews or downloads after the provider accepts the prompt;
- attachment controls in Home, Chat, Notes, child-session modals, or unrelated composer consumers;
- PDF, office-document, archive, audio, video, SVG, or executable-file support;
- provider-side image capability emulation; or
- copying local files into the selected repository or worktree.

## Existing Contracts to Preserve

### Attachment validation

Reuse the existing client draft and strict normalization pipeline:

- `src/client/utils/attachment-draft.ts`
- `src/core/kanban/task-attachments.ts`

The limits remain:

| Limit | Value |
|---|---:|
| Files per prompt | 5 |
| Images per prompt | 3 |
| Text file size | 256 KiB each |
| Image size | 2 MiB each |
| Total decoded size | 6 MiB |
| Filename length | 255 characters |

Supported images remain PNG, JPEG, and WebP with signature validation. Supported text extensions
and extensionless UTF-8 text files remain those accepted by `task-attachments.ts`. Do not create a
second allowlist or a relaxed timeline-only validator.

### ACP prompt semantics

`useAcp().promptSession` already accepts either a string or `AcpContentBlock[]`. The Web prompt
route already preserves text resources and image blocks, rejects an unsupported image prompt as a
whole, and records visible text without copying attachment bytes into transcript text.

Follow-up attachments must use this existing path. No API-contract change is required.

### Target session

The timeline composer continues to address the top-level Team Run `sessionId`, which is the Team
Lead session. It must not redirect the prompt to the currently focused child Agent or the session
shown in the optional detail modal.

## Decisions

### 1. Send follow-up files directly with the prompt

Unlike initial Team launch, the existing Team Run page does not navigate before sending. Therefore
follow-up attachments stay as browser `File` objects in React state and are serialized immediately
before `promptSession`.

Do not use the initial-launch IndexedDB handoff for follow-up prompts. That helper exists only to
carry files across navigation from Team launch to Team Run detail.

### 2. Keep the operation atomic

The client must validate and build the complete content-block array before calling `promptSession`.
If any file fails serialization or strict normalization, send nothing. If the provider cannot
receive an image, the existing backend capability check must reject the whole prompt; it must never
send the text while silently dropping the image.

### 3. Preserve the draft until backend acceptance

Text, repository references, and local `File` objects remain available until `promptSession`
resolves successfully.

- Success: clear the editor, attachment drafts, attachment errors, and failed-submission state.
- Preparation or delivery failure: restore/preserve the text and exact attachment snapshot and show
  a localized error.
- Route change or full page refresh: follow-up drafts may be lost. Durable draft persistence is out
  of scope.

### 4. Use a stable prompt ID for retry

Create one `promptId` when the user submits a new timeline prompt and pass it through
`promptSession(..., { promptId, throwOnError: true })`. Store that ID with the failed submission.
Retrying an unchanged failed submission must reuse the same ID and the same content snapshot.

This matters when the browser loses the response after the backend/provider already accepted the
prompt. Generating a new ID during Retry could create a duplicate turn.

If the user changes the text, adds/removes an attachment, changes an `@` repository reference, or
changes the selected repository after failure, invalidate the old failed-submission retry token.
The next Send is a new submission with a new `promptId`.

### 5. Treat `@` references and local attachments as separate inputs

Change the timeline `onSend` handler to accept `InputContext` and resolve `context.files` through
the existing `resolveRepositoryFileReferences` boundary. The visible prompt may contain a compact
repository-relative file list, while local files become ACP resource/image blocks.

The two inputs remain distinct:

```text
@ repository file -> repository-relative path in a visible text block
paperclip file     -> embedded text resource or image content block
```

### 6. Generalize the first-prompt builder instead of duplicating it

`src/client/utils/team-first-prompt.ts` already constructs the required ordered content blocks.
Generalize its naming to represent any Team prompt, for example:

```ts
interface TeamPromptContentInput {
  text: string;
  repositoryFiles?: RepositoryFileReference[];
  attachments?: NormalizedTaskAttachment[];
  resourceScopeId: string;
}

function buildTeamPromptContentBlocks(
  input: TeamPromptContentInput,
): AcpContentBlock[];
```

The initial-launch call supplies its attachment transfer ID as `resourceScopeId`. A follow-up
submission supplies its stable `promptId`. Keep a compatibility export temporarily if it reduces
the change size, but do not leave two implementations of the block-ordering rules.

Block order remains:

1. user text;
2. repository-file section, when present;
3. UTF-8 attachments as embedded `resource` blocks; and
4. images as `image` blocks.

Attachment content must never be copied into visible text merely to make it appear in history.

### 7. Keep text-only follow-ups behaviorally unchanged

When a follow-up contains neither local attachments nor repository references, it may continue to
call `promptSession` with the plain string. It must still pass the stable `promptId` so retry is
idempotent. This minimizes behavior changes for the common text-only path.

## Proposed Client State

Keep state local to `TeamRunPageClient`; do not introduce a global attachment store.

```ts
interface TimelinePromptSubmission {
  promptId: string;
  text: string;
  attachmentDrafts: TaskDraftAttachment[];
  repositoryFiles: RepositoryFileReference[];
}

const [timelineAttachmentDrafts, setTimelineAttachmentDrafts] = useState<
  TaskDraftAttachment[]
>([]);
const [timelineAttachmentErrors, setTimelineAttachmentErrors] = useState<string[]>([]);
const [failedTimelineSubmission, setFailedTimelineSubmission] = useState<
  TimelinePromptSubmission | null
>(null);
```

The existing `failedTimelinePrompt: string | null` should be replaced by the structured failed
submission rather than adding a second independent retry state.

The attachment array stored in a submission is a snapshot of the `File` references at Send time.
Attachment mutation is disabled while sending, so a single in-flight submission cannot change.

## Proposed Runtime Flow

```text
User enters text
  -> optionally selects @ repository references
  -> optionally selects/drops local files
  -> client preflight merges valid attachment drafts
  -> user clicks Send
  -> capture text + repository refs + attachment File snapshot + promptId
  -> serialize File bytes
  -> strict normalizeTaskAttachments validation
  -> build ordered ACP content blocks
  -> promptSession(root Team Lead session, payload, { promptId, throwOnError: true })
     -> accepted: clear complete composer draft
     -> rejected/unknown: preserve complete snapshot and show Retry
  -> Retry reuses identical promptId and snapshot
```

## UI Behavior

### Composer

Enable the existing `TiptapInput` attachment controls in the Team Run timeline:

```tsx
<TiptapInput
  attachmentsEnabled
  attachmentDrafts={timelineAttachmentDrafts}
  attachmentErrors={timelineAttachmentErrors}
  attachmentsDisabled={timelinePromptSending}
  onAddAttachmentFiles={handleAddTimelineAttachmentFiles}
  onRemoveAttachment={handleRemoveTimelineAttachment}
  onSend={(text, context) => handleTimelinePrompt(text, context)}
  // existing props unchanged
/>
```

Reuse `addAttachmentDrafts`, `formatAttachmentValidationError`, and the existing attachment chips.
Do not create a second picker component.

The send button must continue to require non-empty user text. An attachment alone does not send a
Team prompt in this version.

### Failure and retry

- While sending, disable file add/remove and duplicate Send.
- On preparation failure, show the localized attachment error and retain files and text.
- On provider/recovery failure, keep the existing Team prompt error panel and Retry action.
- Retry is available only while the visible draft still represents the failed submission.
- Editing the failed draft invalidates that retry snapshot; the user sends the edited content as a
  new submission.
- For `prompt_images_unsupported`, explain that the entire prompt was not sent and invite the user
  to remove images or select a provider with image support.

### Placeholder wording

Clarify that `@` references repository files:

```text
English: @ repository file
Chinese: @ 引用仓库文件
```

Do not translate `@` as local attachment. The paperclip's accessible label remains the local-file
action.

## i18n Changes

All new or changed strings must remain in the i18n dictionaries and type contract.

Expected changes:

- update `chatPanel.fileHint` in English and Chinese to mean repository-file reference;
- update comments that describe `teamAttachments` as launch-only;
- add a follow-up preparation/delivery message only if existing generic messages cannot express the
  state accurately;
- change `teamRuntime.promptErrorImagesUnsupported` from “first Team prompt” to “Team prompt” so it
  is correct for both launch and follow-up sends; and
- update `src/i18n/types-tail.ts` for any added keys.

Do not hardcode fallback English or Chinese literals in React components.

## Implementation Boundaries by File

### Required production changes

| File | Responsibility |
|---|---|
| `src/app/workspace/[workspaceId]/team/[sessionId]/team-run-page-client.tsx` | Own follow-up draft state, capture `InputContext`, build/send/retry structured submissions, and wire attachment props. |
| `src/client/utils/team-first-prompt.ts` | Generalize first-prompt-only names into a shared Team prompt content-block builder without changing block semantics. |
| `src/client/components/tiptap-input.tsx` | Update launch-only comments/docs; behavior should already be reusable. |
| `src/client/utils/attachment-draft.ts` | Update launch-only comments if necessary; do not duplicate validation. |
| `src/i18n/locales/en.ts` / `zh.ts` | Clarify `@` repository-file hint. |
| `src/i18n/locales/en-tail.ts` / `zh-tail.ts` | Generalize Team attachment/error copy. |
| `src/i18n/types-tail.ts` | Keep translation keys type-safe if keys change. |

### No production change expected

- `api-contract.yaml`
- `src/app/api/acp/**`
- `src/core/acp/session-prompt.ts`
- Task routes and Artifact stores
- `src/client/utils/team-attachment-transfer.ts`
- database schemas and migrations

If implementation reveals a backend change is required, stop and document the missing protocol
behavior before expanding scope. The existing ACP tests indicate follow-up content blocks should
already work.

## Characterization Tests Before Refactor

Before renaming/generalizing the prompt builder, extend the existing tests to lock these behaviors:

1. text-only Team prompt produces one text block;
2. repository references remain repository-relative and reject paths outside the selected repo;
3. text attachment content is emitted only as an embedded resource;
4. image attachment content is emitted only as an image block;
5. resource URIs use the supplied scope ID; and
6. attachment ordering is deterministic.

Keep these tests in `src/client/__tests__/team-first-prompt.test.ts` or rename the test/file together
with the helper. Avoid a compatibility test suite that permanently duplicates the same assertions.

## Required Component Tests

Extend
`src/app/workspace/[workspaceId]/team/[sessionId]/__tests__/team-run-page-client.test.tsx`.
The current `TiptapInput` mock must capture props and expose test controls for Send, adding files,
removing files, and attachment-state inspection.

Minimum cases:

1. Existing Team Run renders the timeline composer with attachments enabled.
2. Adding valid files displays/preserves the draft and localized validation failures reject invalid
   files before dispatch.
3. Text-only Send continues to dispatch the same visible text and now includes a stable `promptId`.
4. Text plus a text attachment dispatches a text block followed by an embedded resource.
5. Text plus an image dispatches atomically as text and image blocks.
6. `@` references are converted to safe repository-relative paths and included in the prompt.
7. Successful acceptance clears text, attachments, errors, and retry state.
8. Serialization/normalization failure calls no ACP method and preserves the complete draft.
9. ACP rejection preserves the complete draft and displays the existing error panel.
10. Retry sends the exact same content with the exact same `promptId`.
11. Editing/removing/adding after failure invalidates the old retry snapshot; the next Send uses a
    new `promptId`.
12. `prompt_images_unsupported` preserves all files and sends no partial prompt.
13. Pending initial-prompt retry remains unchanged and still rebuilds the initial attachment blocks
    from IndexedDB.
14. Recovery/ownership failures still retain the unsent text and attachments.

Also retain the existing lower-level Web ACP tests for image capability and all-or-nothing dispatch.
Add a new backend test only if the current suite does not exercise content blocks after the first
prompt has already been marked sent.

## Manual Browser Verification

Use `agent-browser` against a real local Team Run and keep evidence outside the repository.

Walkthrough:

1. Open an existing Team Run and verify a paperclip button is visible in the timeline composer.
2. Confirm `@` searches repository files and does not open the local picker.
3. Add one text file and one supported image; verify both chips and removal controls.
4. Send the prompt to a provider with image capability; verify one user turn and no Base64/content
   leakage in visible transcript text.
5. Trigger a failed send or use a provider without image capability; verify no partial text turn,
   retained files, localized error, and usable Retry/removal controls.
6. Retry an unchanged failed prompt and verify only one provider turn is created.
7. Send a later text-only prompt and verify unchanged behavior.

Do not commit screenshots or recordings.

## Validation Commands

Run focused checks first:

```bash
npx vitest run src/client/__tests__/team-first-prompt.test.ts
npx vitest run 'src/app/workspace/[workspaceId]/team/[sessionId]/__tests__/team-run-page-client.test.tsx'
npx vitest run src/client/components/__tests__/tiptap-input.test.tsx
npx tsc --noEmit
```

Then run the repository-required gates before PR:

```bash
npm run fitness:run -- --tier fast --scope local --min-score 0
npm run fitness:run -- --tier normal --scope local --min-score 0
npm run validate:web
```

Fix and rerun failures; do not skip source-code validation because the implementation changes
runtime behavior.

## Acceptance Criteria

The implementation is complete only when:

1. a paperclip picker works in an existing Team Run timeline;
2. supported text and image files reach the Team Lead with a follow-up prompt;
3. `@` clearly means repository-file reference and continues to work;
4. invalid or unsupported attachments cause zero prompt dispatch;
5. failed sends retain the entire editable draft;
6. unchanged Retry is idempotent through a stable `promptId`;
7. attachment bytes never appear in visible transcript text, logs, URLs, session storage, or error
   messages;
8. successful sends clear the complete draft only after backend acceptance;
9. initial Team launch attachments and text-only follow-ups remain unchanged; and
10. focused tests, TypeScript, fitness gates, `validate:web`, and manual browser verification pass.

## Suggested Commit Boundary

Keep this as one behavior concern and under the repository commit budget if practical:

```text
feat(team): support attachments in follow-up prompts
```

Include exactly one allowed co-author trailer when committing, per the repository `AGENTS.md`.
