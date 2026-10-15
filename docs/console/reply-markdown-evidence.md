# Reply markdown evidence (#59)

## Sources and screenshots

Before source: `41da0f423f9c225cfe27a9059d59d8df0b981599` (main plus the fixture's markdown reply, page unchanged). After source: `8a6043c176ba6a47205f2477e37bb3fb8cfcf6e0`.

Both captures used `test/fixtures/tui-host.mjs`: temporary agent folders, real SQLite stores, a scripted faux model and a fake CLI. No real agents, credentials, wallets, model providers or marketplace servers were used. Chromium ran through Python Playwright with `bypass_csp=True`. Desktop viewport: 1440 x 1050. Phone viewport: 390 x 844. Device scale: 1. Each shot is the turn card that holds the shop agent's markdown reply to the `bid.created` event.

| Surface | Before | After |
| --- | --- | --- |
| Desktop light | [Before](reply-markdown-before-desktop-light.png) | [After](reply-markdown-after-desktop-light.png) |
| Desktop dark | [Before](reply-markdown-before-desktop-dark.png) | [After](reply-markdown-after-desktop-dark.png) |
| Phone light | [Before](reply-markdown-before-phone-light.png) | [After](reply-markdown-after-phone-light.png) |
| Phone dark | [Before](reply-markdown-before-phone-dark.png) | [After](reply-markdown-after-phone-dark.png) |

## Terminal UI

[The capture script](../tui/reply-markdown-capture.py) follows the `docs/tui/steer-capture.py` method. It starts the same fixture host, runs the real Bun/OpenTUI client in tmux inside Zutty on X11, and saves the window's pixels with ImageMagick `import -window` and the pane's text with `tmux capture-pane`. The after client is `src/tui` at the after source. The before client is a copy of that `src/` with `src/tui/app.tsx` restored from the before source, which is the only TUI file that draws replies.

| Terminal | Before | After |
| --- | --- | --- |
| 130 x 52 | [Before](../tui/reply-markdown-before-normal.png) ([text](../tui/reply-markdown-before-normal.txt)) | [After](../tui/reply-markdown-after-normal.png) ([text](../tui/reply-markdown-after-normal.txt)) |
| 90 x 52 | [Before](../tui/reply-markdown-before-narrow.png) ([text](../tui/reply-markdown-before-narrow.txt)) | [After](../tui/reply-markdown-after-narrow.png) ([text](../tui/reply-markdown-after-narrow.txt)) |

## What the captures measured

Playwright read these values from the live page in every surface, before and after:

| Measure | Before | After |
| --- | --- | --- |
| Reply card width, desktop / phone | 846px / 342px | 846px / 342px |
| `script` and `img` elements inside the app | 0 | 0 |
| Links whose address is not `http:` or `https:` | 0 | 0 |
| Page errors | none | none |

Before, the 300-character code line ran past the card edge and the card clipped it. After, it wraps inside the code plate, and the card keeps its width at 390px. Both versions measure a 404px document at the 390px phone viewport. That is the attention section's known 14px overflow, recorded in [steer-web-evidence.md](steer-web-evidence.md), and this change leaves it as it was.

Contrast: Code Ink (#E9E7DC) on Sign Black (#0B0B0B) is about 15.8:1, in both themes. Link ink is about 6.7:1 on white in light and about 7:1 on the dark panel.

## Local validation

| Command | Result |
| --- | --- |
| `pnpm check` | 346 tests in 25 files; TypeScript, skills, prose and lessons checks passed |
| `pnpm exec vitest run test/console-page.test.ts` | 27 tests passed, including the markdown subset, raw HTML, `javascript:` and image syntax, streaming and peek cases |
| `pnpm tui:test` | TUI typecheck passed; 6 tests passed, 553 `expect()` calls |

## Reproduce locally

In a worktree at either source commit, run `pnpm install --frozen-lockfile`, then `node test/fixtures/tui-host.mjs`. Open the printed console link and select `shop`. About two seconds later the `bid.created` turn shows the markdown reply. Stop the fixture with Ctrl+C; it removes its temporary stores. Never substitute `pnpm agents` or real agent folders.

## Limits

These checks do not establish CI, staging or production readiness.
