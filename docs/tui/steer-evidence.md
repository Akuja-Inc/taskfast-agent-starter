# Terminal steering evidence

## Source and provenance

All captures ran in `.worktrees/gh39-steer-tui`, branch `gh39-steer-tui`, based on `1ec0f9401c1d80d7e21eaae4ba73f23c02df2015` with Pi 1.1.0. No dependency pins or lockfiles changed. No commit, push, PR or rebase was performed for this slice.

The before images show that commit's unchanged terminal client. The after images show the uncommitted TUI slice on that same base. [The source manifest](steer-after-source.json) records SHA-256 hashes of the exact source files used for the after capture. In particular, `src/tui/app.tsx` hashes to `df66e8fc6a01c52e105a7a82755e0568801879a04a9b41ecb495d801117f0940`. The parent must pin the reviewed source commit after committing and rebasing the slice; these captures do not claim to show a future commit or Pi 1.2.0.

[The capture script](steer-capture.py) starts `test/fixtures/tui-host.mjs`, which creates temporary agent folders and real SQLite stores, uses a scripted faux model and fake CLI, and removes the temporary folders on shutdown. It seeds two follow-ups and one direct steer through the real console API while paused. It runs the actual Bun/OpenTUI client inside tmux and Zutty on X11, then uses ImageMagick `import -window` to capture the terminal window's pixels. No screenshot is drawn, reconstructed, composited or populated from a hand-made UI fixture. All displayed data is synthetic. No marketplace, model provider or real agent folder was contacted.

## Captures

| Layout | Before | After |
| --- | --- | --- |
| 130 × 44 | [Normal](steer-before-normal.png) | [Focused queue](steer-after-normal.png) |
| 90 × 44 | [Sidebar via i](steer-before-narrow.png) | [Queue reached via Tab](steer-after-narrow.png) |
| 130 × 36 | [Help](steer-before-help.png) | [Help](steer-after-help.png) |

Matching `.txt` files contain tmux's captured terminal text. The after normal and narrow images show the first queued request selected. The capture script presses Tab twice, without i, for both after layouts.

```sh
pnpm install --frozen-lockfile
pnpm build
# Before applying the TUI slice, with unchanged TUI source:
python3 docs/tui/steer-capture.py before
# After applying the TUI slice:
python3 docs/tui/steer-capture.py after
pnpm check
pnpm tui:test
```

The capture requires Bun, tmux, Zutty, X11, xwininfo and ImageMagick. Never run pnpm install inside `src/tui/`.

## Validation

The pure queue test failed before implementation. The mode/retry/error tests then failed before their implementation. The rendered focused-composer test failed before the Ctrl+S handler existed.

Final local results: `pnpm check` passed typecheck, 24 test files and 311 tests, skill validation, prose-wrap validation and the lessons ledger. `test/tui.test.ts` contains 14 passing tests. `pnpm tui:test` passed its separate TypeScript check and all 6 rendered Bun smoke tests, with 598 assertions in the recorded final run. `git diff --check` passed.

The rendered smoke covers focused Ctrl+S without an inserted control byte, Enter follow-ups, selected-ID promotion, direct API steering, paused admission and resume, narrow queue access, a real accepted send with an injected lost acknowledgement, identical ID/mode on retry without duplicate delivery, a real late-promotion 404 and its exact notice, stale selection without another request, and Briefing's spending-limit confirmation and save/reopen. Pure tests additionally cover promotion 409 and unrelated-route error preservation. This is local validation only, not staging or production validation.
