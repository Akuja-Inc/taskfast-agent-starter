# Terminal steering evidence

## Source and provenance

Both capture sources use Pi 1.2.0. The before source is `f1eebfc4a05caf1e66b92b91be435040f61af11f`. The after source is `ad02e3e972afc97ff9351067ee34b5075842d775`. [Before](steer-before-source.json) and [after](steer-after-source.json) manifests record each exact source commit, application-source SHA-256 hashes and a separate capture-script hash. The capture script refuses modified application sources.

[The capture script](steer-capture.py) starts `test/fixtures/tui-host.mjs`, which creates temporary agent folders and real SQLite stores, uses a scripted faux model and fake CLI, and removes the temporary folders on shutdown. It seeds two follow-ups and one direct steer through the real console API while paused. It runs the actual Bun/OpenTUI client inside tmux and Zutty on X11, then uses ImageMagick `import -window` to capture the terminal window's pixels. No screenshot is drawn, reconstructed or composited. All displayed data is synthetic. No marketplace, external model provider or real agent folder was contacted.

## Captures

| Layout | Before | After |
| --- | --- | --- |
| 130 × 44 | [Normal](steer-before-normal.png) | [Focused queue](steer-after-normal.png) |
| 90 × 44 | [Sidebar via i](steer-before-narrow.png) | [Queue reached via Tab](steer-after-narrow.png) |
| 130 × 36 | [Help](steer-before-help.png) | [Help](steer-after-help.png) |

Matching `.txt` files contain tmux's captured terminal text. The after normal and narrow images show the first queued request selected. The capture script presses Tab twice, without i, for both after layouts.

## Reproduce

Use installed worktrees at the source commits above. Run these commands from the after-source repository root. Set `BEFORE_WORKTREE` to the before-source worktree. Its build writes only ignored output. Both sources need their pinned Bun packages installed through the normal TUI launcher.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm tui:test
pnpm --dir "$BEFORE_WORKTREE" tui:test
python3 docs/tui/steer-capture.py before "$BEFORE_WORKTREE"
python3 docs/tui/steer-capture.py after
```

The capture requires Bun, tmux, Zutty, X11, xwininfo and ImageMagick. Never run pnpm install inside `src/tui/`. Output always goes beside the capture script, even when the source is another worktree.

## Validation

At after-source commit `ad02e3e972afc97ff9351067ee34b5075842d775`, `pnpm install --frozen-lockfile` passed with the inherited Pi 1.2.0 pins. `pnpm check` passed typecheck, 25 test files and 328 tests, skill validation, prose-wrap validation and the lessons ledger. `test/tui.test.ts` contains 14 passing tests. `pnpm tui:test` passed its separate TypeScript check and all 6 rendered Bun smoke tests, with 598 assertions in the final recorded run. `git diff --check` passed.

The rendered smoke covers focused Ctrl+S without an inserted control byte, Enter follow-ups, selected-ID promotion, direct API steering, paused admission and resume, narrow queue access, a real accepted send with an injected lost acknowledgement, identical ID/mode on retry without duplicate delivery, a real late-promotion 404 and its exact notice, stale selection without another request, and Briefing's spending-limit confirmation and save/reopen. Pure tests additionally cover promotion 409 and unrelated-route error preservation. This is local validation only, not staging or production validation.
