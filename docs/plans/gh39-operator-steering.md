# Plan: steer a busy agent (#39)

Status: approved in Plannotator before implementation. The core/API slice passes the local gate; browser and terminal slices follow separately.

Source: [issue #39](https://github.com/Akuja-Inc/taskfast-agent-starter/issues/39).

## Outcome

Enter sends a follow-up for the next run. Ctrl+S or Cmd+S sends a steer after the current tool round. A queued follow-up can also be promoted with Steer. Both the browser console and the TUI show queued operator messages and explain when the agent already has one.

Steering is not cancellation. It cannot undo a tool call or a money action already in flight.

## Starting point and boundaries

- Initial base was `a414051` with Pi 1.1.0. During implementation, separate PR #43 merged Pi 1.2.0 into main at `a86e824`. The core slice was rebased onto it and revalidated there. This change adds no dependency or lockfile delta.
- Work in dedicated worktrees. The first is `.worktrees/gh39-steer-core-api`, branch `gh39-steer-core-api`. Leave the existing dirty `.worktrees/gh39-console-steer` and the main checkout's untracked `make-110-store.mjs` untouched.
- Use temporary agent folders, real persistent SQLite stores, a scripted model and a fake CLI. Do not start real agents or contact staging or production.
- Leave policy, action keys, reservations, spending, tools, CLI children, stream acknowledgement and Pi queue settings unchanged.
- Keep the Operator document at version 1 with additive, defaulted fields. Read old messages without a mode as `followUp`, and missing intent state as empty. Do not migrate or reset existing documents or stores.

## Delivery: three PRs

Keep the issue's slices, rather than one large PR. Open them as a dependent stack so no merge is needed to complete the work.

| PR | Contents | Base | Source marker |
|---|---|---|---|
| 1 | Durable message modes, promotion, recovery, queue view, console API and tests | `main` | `Refs #39` |
| 2 | Browser shortcuts, queued-message list, Steer buttons and browser proof | PR 1 branch | `Refs #39` |
| 3 | TUI shortcuts, queue selection, help, smoke tests and terminal proof | PR 2 branch | `Closes #39` |

Each branch contains only its slice relative to its base. Refresh the base before implementation. If main changes the Pi pin, recheck the queue contract before proceeding instead of silently bundling or reversing that upgrade. No merging is authorized.

## PR 1: durable core and API

### Message admission

Extend `OperatorControls.message()` with an optional steer flag. Store each new message's explicit `followUp` or `steer` mode in the session-scoped Operator document before acknowledging it. Keep the existing request ID deduplication and text validation.

Drain messages through the existing recovery path using their stored `whenBusy` mode. Preserve `MESSAGE_PREFIX` so both forms remain operator messages in the timeline. Let Pi handle the idle case without a second scheduling path.

While paused, keep messages durable without submitting new work. On resume, submit buffered steers before buffered follow-ups, preserving order within each mode. Recheck pause before each dispatch so a pause committed mid-drain stops subsequent work. Sending a steer and promoting a buffered follow-up both work while paused.

### Promote an existing follow-up

Add `operator.steer(requestId)` and serialize it with message admission and recovery so a drain cannot race the buffered-message update.

| Message state | Change and effect |
|---|---|
| Buffered in Operator document | Change mode to `steer` in one commit; keep its text and original identity |
| Queued as a Pi follow-up | Commit intent containing the original submission ID, text and message order; only then call `Submission.abort()` |
| Original is now aborted | Submit the same prefixed text as a steer with `operator-steer:<requestId>`; clear the intent only after durable admission |
| Abort reports `already_placed`, or the original genuinely finished | Clear the intent; do not resubmit; return the late-steer notice |
| Recovery sees `settled` after an earlier successful abort | Read the original persisted record; `unanswered` with `reason: "aborted"` and no placed entry, tied to this intent, still requires the replacement |
| Intent already pending or message already steered | Treat the retry as a no-op; never create another input |
| Unknown or finished request without a pending promotion | Return 404; change nothing |

The original Pi submission keeps `operator:<requestId>`. The promoted submission uses the distinct deterministic ID `operator-steer:<requestId>`. A durable intent records the transition between them; Pi's request deduplication alone is not enough to prevent delivery of both.

Recover pending intents before draining fresh follow-ups. Reacquire the original with `owner.submission(submissionId)` and read its persisted status. Pi's `inspect()` omits settled records, so a missing queue row is not proof that abort succeeded. Treat a missing original record as an error, not permission to deliver another input.

A paused promotion may withdraw the original queued follow-up, but must retain the intent and defer its replacement until resume. A restart must do the same. Pi's commits make abort and inbox removal atomic; the kit must bridge abort and replacement durably.

Verified at the initial 1.1.0 pin and rechecked after adopting main's 1.2.0 pin: `whenBusy`, `Submission.abort()`, `owner.submission()`, `InboxDoc` and request deduplication already exist. Crucially, aborting an already aborted input returns `settled`, not `aborted`. Recovery must inspect the saved status rather than apply the fresh-request late-steer rule blindly.

### API and view

- `POST /api/agents/:id/messages` accepts `steer: true` or an absent field. Reject `false`, null, strings and other malformed values with 400, as the issue requires.
- Add `POST /api/agents/:id/steer/:requestId`, which fits the existing console route structure, with the same token, host, origin and request-ID checks.
- Keep admission durable before responding. Return 204 for successful or idempotent promotion, 409 for a late placement race, and 404 for an unknown or finished ID. Clients show the late-race response as a notice, not a failed send.
- A late race reports exactly: "The agent already has this message." An unknown or already finished ID returns 404 with a clear message.
- Add `operator.queued()` and a `queuedMessages` view field built from the Operator buffer, pending promotion intents and Pi's inbox. Deduplicate by public message ID and show oldest first, with text and mode. Preserve original admission order through promotion; use existing queue order for legacy messages without metadata. Exclude events, check-ins, resume inputs, aborted originals and already placed messages.
- Derive queue visibility and controls from the running host. Do not open another store, add a second event stream or expose Pi internals to either client.

### Recovery proof

Test all three interrupted transitions against reopened persistent stores:

1. Intent committed, abort not called yet.
2. Original aborted, promoted submission not admitted yet.
3. Promoted submission admitted, intent not cleared yet.

Assert one delivery total, the surviving mode, the expected request IDs and intent cleanup. First prove that a direct steer arrives after tools in the same run while a follow-up waits until the answer; also prove both start work when idle. Add concurrent promotion, late placement, a failed run with queued work, pause/restart/resume, mid-drain pause, mixed-mode ordering, old documents without modes, and original-send retries during promotion. Keep existing ownership and policy-persistence regressions green.

Use explicit synchronization at commit and tool-round boundaries, not sleeps. Where graceful shutdown would change the state being tested, use a temporary subprocess crash harness rather than copying a live SQLite store.

## PR 2: browser console

Preserve the existing yellow-sign console, both themes, plain-text rendering and responsive layout. This is a feature addition, not a redesign.

- Separate send mode from the common dedup-safe submit path: Send and Enter remain follow-ups; Ctrl+S and Cmd+S set `steer: true`; Shift+Enter still adds a newline. Prevent the browser's Save Page shortcut.
- Retain one request ID for retries of the same attempted send, including its mode. Clear the draft only after successful admission.
- Add a queued-messages section near the composer, outside the sticky editor so a long queue does not cover the timeline. Show oldest first, plain message text and a readable Follow-up or Steer label. Give only follow-ups a Steer button.
- Keep controls available while paused. Prevent duplicate in-flight actions, but do not disable steering because the agent is paused.
- Handle queue changes by message ID so a live refresh cannot steer a different row. Update the queue without replacing or suppressing the active composer draft. Show the exact late-steer notice as non-blocking status feedback.
- Update keyboard hints and README guidance. Test empty, mixed-mode, paused, loading, failed promotion and late-race states. Cover long text, keyboard focus, phone layout and both themes.

## PR 3: terminal UI

Keep all interaction decisions in the pure `screen.ts` and `keys.ts` modules, with `app.tsx` handling rendering and API calls.

- Add queued messages and their mode to the Agent sidebar. Introduce explicit queue focus and stable request-ID selection. Tab reaches the queue; j/k selects a row. Keep it reachable with the existing sidebar toggle on narrow terminals.
- Ctrl+S sends a steer only while composing a Timeline message. Enter sends a follow-up. Verify the focused OpenTUI input does not swallow Ctrl+S or insert it as text.
- `s` promotes the selected queued follow-up, not an index that could point to a different message after refresh. Show the same late-steer notice as the browser.
- Preserve Briefing's Ctrl+S save behavior and its spending-limit confirmation. Do not intercept that shortcut as a send.
- Update `HELP`, the message hint and README. Extend the real console-API smoke test for direct steering, promotion, pause/resume and the key-focus boundary.

## Validation and PR evidence

The test seams covered by this approval are the public operator controls and reopen lifecycle, the model's observed input sequence, console HTTP and streamed views, pure TUI screen/key functions, and the rendered browser and terminal. Use real stores and Pi scheduling; mock only the model and external CLI boundary.

For each slice, work one behavior at a time: first add a failing regression test, then implement the smallest change that makes it pass. Do not write the whole imagined suite before implementing.

1. Run focused regressions in `src/core/operator.test.ts`, `src/core/agent.test.ts`, `test/runtime-crash.test.ts`, `test/console.test.ts`, `test/console-host.test.ts`, `test/console-page.test.ts` and `test/tui.test.ts`, as applicable. The core slice stages each interrupted promotion in `src/core/steering.test.ts` using real Pi submissions and durable document commits, then closes and reopens the same store. No copied live store or power-loss claim. Extend `src/tui/smoke.test.tsx` and `test/fixtures/tui-host.mjs` for rendered key handling and controlled busy work.
2. Run `pnpm check`, the full repository gate, and record exact counts.
3. Run `pnpm tui:test` for the API slice and both client slices. This checks `app.tsx` under Bun, which CI does not cover. Include the run output in the relevant PR evidence.
4. Exercise the browser and TUI against a throwaway host with deterministic queued work. Capture before/after screenshots under `docs/`, pinned to the source commit SHA. Browser checks include desktop light/dark and phone; terminal checks include normal and narrow sidebar layouts. Never capture a real console token or private agent data.
5. Fill every PR-template slot. Include the changed state-transition table, test links, a diff-focused Mermaid diagram, a reproducible local command, truthful deployment notes and applicable lessons. Use the required N/A wording where appropriate.
6. Check staged files for credentials, live state, agent folders and unrelated changes before committing. Use commit messages that complete "applying this change will ...".
7. Open each PR with its correct base and issue marker. Report required CI accurately; leave a PR draft while its required gates are not green. Stop at the PR URLs without merging or starting a CI/review babysitting loop.

## Approval

Approving this plan authorizes implementation and opening the three dependent PRs above. It does not authorize live marketplace runs, dependency upgrades, changes to existing unfinished work, or merging.
