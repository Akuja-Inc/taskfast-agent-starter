# Queued-message withdrawal

The console's Withdraw button and the TUI's queue-focused `w` remove a follow-up or steer before Pi places it into the conversation. Placement, not model completion, is the cutoff. Withdrawal cannot cancel work the agent already received.

## State transitions

`DELETE /api/agents/:id/messages/:requestId` uses the immutable request ID, so it needs no standing-order-style `expect` text. The route uses the console's existing token, Host, Origin and request-ID checks. HTTP statuses below come from the local console API, not TaskFast's server API.

| State when the transaction runs | Outcome | Persistent changes | Controls and retry |
| --- | --- | --- | --- |
| Buffered while paused, either mode | 204 | Remove buffer and admission-order entry; retain request tombstone | Withdraw available while paused; same ID cannot be sent again |
| Original or promoted submission queued in Pi | 204 | Settle every queued original/replacement as unanswered/aborted; remove inbox items, buffer, intent and admission-order entry; retain tombstone | Withdraw available for follow-ups and steers |
| Promotion intent with an already-aborted original | 204 if no input was placed | Clear intent and any duplicate buffer; also remove queued replacement if present; retain tombstone | Resume/recovery cannot create the replacement |
| Original or replacement placed or finished | 409 | None | Show "The agent already has this message." Never claim withdrawal |
| Unknown request ID | 404 | None | Show the same stale-row notice as steering |
| Previously withdrawn ID | 204 | None | Repeated DELETE and retried original sends cannot resurrect it |
| Storage commit fails | Error, not 204 | No partial batch | After reopen the queue still contains the message; withdrawal can be retried |

Operator admission, drain, promotion and withdrawal share the host's operator line. One Pi session transaction reads both submission identities, checks placement, settles queued records, removes inbox items, clears operator buffers/intents and records the tombstone. Pi placement uses that same transaction line. No dispatch, money policy or event admission behavior changes. Tombstones contain only request IDs and are permanent, including for messages withdrawn before any Pi submission existed.

The browser keeps controls keyed by ID and moves focus to a neighboring Withdraw button, or to the composer when the queue empties. The TUI uses ID-bound selection and selects a visible neighbor after an acknowledged withdrawal, or returns to Timeline when none remain. If the stream removes a withdrawal target before its reply arrives, or its reply is lost, focus returns to Timeline instead. An unexpected disappearance does not select another message for deletion. Both clients keep unrelated composer drafts intact. Failed requests remain retryable; 404/409 are queue notices, not failed draft sends.

## Reproduce

```sh
pnpm exec vitest run src/core/steering.test.ts test/console.test.ts test/console-page.test.ts test/tui.test.ts
pnpm check
pnpm tui:test
```

Local validation passed: `pnpm check` ran 25 test files and 377 tests plus typecheck, skill, prose-wrap and lessons-ledger gates. `pnpm tui:test` passed its separate TypeScript check and all 9 rendered smoke tests with 889 assertions.

The steering suite covers buffered and Pi-inbox removal, concurrent retries, placement races in both directions, queued and already-received promotion replacements, interrupted promotion stages, failed withdrawal commits, persistent reopen, ownership refusal and no delivery after resume. The separate rendered TUI smoke test exercises the real HTTP boundary, paused withdrawal, queue shifts, repeat keys while pending, a lost acknowledgement and a real 409.

## Visual evidence

[The capture script](capture.py) runs `test/fixtures/tui-host.mjs` with temporary agent folders, real SQLite stores, scripted faux models and a fake CLI. It uses Chromium screenshots for the web and ImageMagick `import -window` on a real Zutty/tmux/OpenTUI terminal for the TUI. It does not draw or reconstruct screenshots. No marketplace, external model service or real agent folder is contacted. The browser capture uses the worker fixture's clean timeline; the terminal capture uses the shop fixture with synthetic alerts.

[Before source manifest](before-source.json) and [after source manifest](after-source.json) record exact source commits, source-file SHA-256 hashes and the capture-script hash. The script refuses modified application sources. Each terminal image has a matching text capture.

| Surface | Before | After |
| --- | --- | --- |
| Web desktop light | [Before](web-before-desktop.png) | [After](web-after-desktop.png) |
| Web desktop dark | [Before](web-before-dark.png) | [After](web-after-dark.png) |
| Web phone, 390 CSS pixels | [Before](web-before-phone.png) | [After](web-after-phone.png) |
| Terminal, 130 columns | [Before](tui-before-normal.png) | [After](tui-after-normal.png) |
| Terminal, 90 columns | [Before](tui-before-narrow.png) | [After](tui-after-narrow.png) |

To recapture, build each source checkout and install its TUI pins through `pnpm tui:test`, then run the script from this checkout:

```sh
python3 docs/withdraw/capture.py before /absolute/path/to/before-worktree
python3 docs/withdraw/capture.py after /absolute/path/to/after-worktree
```

The capture checks desktop/dark/phone horizontal overflow, 44px browser action targets, real DELETE, live row removal, neighbor/composer focus, unchanged drafts, repeated DELETE and browser errors. This is local validation only. No staging or production validation was performed.
