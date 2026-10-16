# Table reply evidence (#85)

## Sources and screenshots

Before source: `92c0b2e6a4560ef5c39d39963ca15e9279063cb1` (main plus the fixture's table reply, page and TUI unchanged). After source: `d50efa2b2032ce452741d8fa822cb2199b0b613e` (this change). The captures ran against those exact trees; the images and this file landed in a later docs-only commit on the same branch.

Both captures used `test/fixtures/tui-host.mjs`: temporary agent folders, real SQLite stores, a scripted faux model and a fake CLI. No real agents, credentials, wallets, model providers or marketplace servers were used. Chromium ran through Python Playwright with `bypass_csp=True`. Desktop viewport: 1440 x 1050, light and dark. Phone viewport: 390 x 844, light. Device scale: 1. Each shot is the turn card that holds the shop agent's table reply to the `bid.created` event.

| Surface | Before | After |
| --- | --- | --- |
| Desktop light | [Before](table-reply-before-desktop-light.png) | [After](table-reply-after-desktop-light.png) |
| Desktop dark | [Before](table-reply-before-desktop-dark.png) | [After](table-reply-after-desktop-dark.png) |
| Phone light | [Before](table-reply-before-phone-light.png) | [After](table-reply-after-phone-light.png) |

## Terminal UI

[The capture script](../tui/table-reply-capture.py) follows the `docs/tui/reply-markdown-capture.py` method. It starts the same fixture host, runs the real Bun/OpenTUI client in tmux inside Zutty on X11, and saves the window's pixels with ImageMagick `import -window` and the pane's text with `tmux capture-pane`. The before pane text holds the raw rows (`| Field | Value |`, `| fee | 0.25 USDC |`); the after pane text holds the same cells as padded columns under a bold head with a muted rule, and no pipe appears.

| Terminal | Before | After |
| --- | --- | --- |
| 130 x 52 | [Before](../tui/table-reply-before-normal.png) ([text](../tui/table-reply-before-normal.txt)) | [After](../tui/table-reply-after-normal.png) ([text](../tui/table-reply-after-normal.txt)) |
| 90 x 52 | [Before](../tui/table-reply-before-narrow.png) ([text](../tui/table-reply-before-narrow.txt)) | [After](../tui/table-reply-after-narrow.png) ([text](../tui/table-reply-after-narrow.txt)) |

## What the captures measured

Playwright read these values from the live page in both viewports, before and after:

| Measure | Before | After |
| --- | --- | --- |
| Reply card width, desktop / phone | 845.7px / 342px | 845.7px / 342px |
| `table` elements inside the reply | 0 | 1 |
| `|` characters in the reply card | 12 | 0 |

The card keeps its width at both viewports, so the table never widens the layout. The reply still renders its other blocks the same way: the fenced 300-character line wraps inside the code plate, and raw HTML, image syntax and the `javascript:` link stay text.

## Local validation

| Command | Result |
| --- | --- |
| `pnpm check` | 630 tests in 37 files passed (3 skipped); TypeScript, skills, prose and lessons checks passed |
| `pnpm tui:test` | TUI typecheck passed; 11 tests passed, 811 `expect()` calls, including the table assertions on the fixture reply |

## Reproduce locally

In a worktree at either source commit, run `pnpm install --frozen-lockfile`, then `node test/fixtures/tui-host.mjs`. Open the printed console link and select `shop`. About two seconds later the `bid.created` turn shows the table reply. The capture scripts are committed here: `docs/console/table-reply-capture.py` for the page and `docs/tui/table-reply-capture.py` for the terminal. Never substitute `pnpm agents` or real agent folders.

## Limits

These checks do not establish CI, staging or production readiness.
