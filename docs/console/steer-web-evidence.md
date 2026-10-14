# Browser steering evidence (#39)

## Source and capture provenance

Baseline source commit: `1ec0f9401c1d80d7e21eaae4ba73f23c02df2015`. The baseline ran in a separate detached temporary worktree at `/tmp/gh39-web-baseline-1ec0f94`. Existing core and baseline worktrees were not edited.

After source: branch `gh39-steer-web`, based on the same commit, with `src/console-page.ts` Git blob SHA `ec820879d63b4cee84dd261fe6f146c43ea315d4` and SHA-256 `5cec65fff9ee7c705deaa707a88e3cfa14dfbb57538b99d55d3d85fb95c537d1`. These hashes pin the exact uncommitted page used for every after capture. The parent must add the final source commit SHA after reviewing and committing this slice. This subagent did not commit, push, rebase or open a PR.

Both hosts ran `node test/fixtures/tui-host.mjs` after `pnpm build`. The fixture creates temporary agent folders and real SQLite stores, supplies a scripted faux model and a fake CLI, and removes its folders on shutdown. No real agent, account, wallet, model provider or marketplace server was used. Both hosts used Pi 1.1.0 and the core/API implementation at `1ec0f94`. The subsequent main/Pi 1.2.0 upgrade is not covered by this evidence.

Python Playwright drove `/snap/bin/chromium` headlessly with `--no-sandbox`. Desktop viewport: 1440 x 1050. Phone viewport: 390 x 844. Device scale: 1. Themes were set explicitly. The shop was paused with the same three synthetic messages, in Follow-up, Steer, Follow-up order. The final message includes a newline, literal HTML-like text and long copy. The browser displayed all server text as text. The URL token was removed by the page before capture. Screenshots contain only synthetic fixture data and a loopback address, not real tokens or credentials.

| Surface | Before, baseline commit | After, page blob above |
| --- | --- | --- |
| Desktop light, full page | [Before](steer-web-before-desktop-light.png) | [After](steer-web-after-desktop-light.png) |
| Desktop dark, full page | [Before](steer-web-before-desktop-dark.png) | [After](steer-web-after-desktop-dark.png) |
| Phone light, full page | [Before](steer-web-before-phone-light.png) | [After](steer-web-after-phone-light.png) |

Queue-focused viewport captures show the new controls more closely: [desktop light](steer-web-after-queue-desktop-light.png), [desktop dark](steer-web-after-queue-desktop-dark.png) and [phone light](steer-web-after-queue-phone-light.png). These are screenshots of the running browser, not mockups or edited images.

## Commands and results

Run from `.worktrees/gh39-steer-web`:

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run test/console-page.test.ts
pnpm check
pnpm tui:test
```

The focused browser-page suite passed 16 tests. The full gate passed 317 tests in 24 files, TypeScript, the skill check, the prose-wrap check and the lessons-ledger check. The final Bun TUI smoke run passed 4 tests with 214 assertions. `git diff --check` passed. These are local checks, not CI, staging or production validation.

The first new shortcut test failed because Ctrl+S omitted `steer: true`. The next admission test failed because changing send keys generated a second in-flight request. The queue test failed because the section did not exist. Each behavior was implemented after its regression failed. A computed browser layout assertion then caught mode/text overlap on rows without a promotion button; the final capture pass and the layout assertion passed after pinning queue prose to the first grid column.

Temporary browser scripts, retained for the parent's local verification:

```sh
python /tmp/gh39-steer-web-browser.py
python /tmp/gh39-steer-web-capture.py
python /tmp/gh39-steer-web-layout.py
python /tmp/gh39-steer-web-empty.py
```

These scripts expect the two fixture host logs at `/tmp/gh39-steer-web-host.log` and `/tmp/gh39-steer-web-baseline-host.log`. The hosts are stopped at handoff. Restart the fixture hosts and use fresh temporary stores before repeating the exercise script. The capture script seeds identical synthetic messages and writes the screenshot paths above.

## Actual browser exercises

- Enter and Send admitted follow-ups; Shift+Enter inserted a newline; Ctrl+S and Cmd+S admitted steers. Ctrl+S also worked with queue-button focus and did not open Save Page.
- A synthetic 503 admission response kept the draft. Retrying with Enter preserved the original request ID, text and Steer mode.
- A gated admission accepted only one request despite repeated Ctrl+S/Cmd+S after Enter. Editing during admission produced a new ID and did not let the older response clear the edit.
- A real streamed queue addition preserved the same focused textarea node, draft and selection. Literal HTML-like queue content did not create DOM elements.
- Real API promotion succeeded while paused. A gated promotion showed "Steering…" and blocked a duplicate action. Only follow-ups offered Steer.
- Injected 409 and stale-row 404 promotion responses showed exactly "The agent already has this message." Neither marked the unrelated draft send failed. An injected 500 left promotion retryable; its retry succeeded against the real fixture API.
- Resume drained the worker's queued messages to the empty state without replacing the focused textarea or changing its draft and selection. With an empty focused composer, subsequent streamed pause/resume changes updated the rest of the page and restored composer focus. A failing regression protected that existing empty-composer live refresh behavior.
- The final phone queue stayed within the 390px viewport, including long text. Promotion targets were at least 44px tall. Desktop light/dark and phone captures had no page errors. The final mode labels and message text did not overlap.

## Remaining boundaries

The pre-existing attention section produces 14px of horizontal overflow in this fixture at 390px. Both baseline and after pages measured a 404px document width. The new queue itself fits the viewport. This slice leaves that unrelated attention layout unchanged.

The parent must review and commit the owned files, pin the after screenshots to that source commit, rebase onto the final core slice, and rerun validation against Pi 1.2.0. Live marketplace work and CI checks were not run. Existing money, policy, API, TUI and dependency files were not changed.
