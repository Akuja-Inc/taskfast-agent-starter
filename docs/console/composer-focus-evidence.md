# Composer focus scroll evidence (#30)

## Sources and screenshots

Before source: `36f6bc2f6c5d09319e458c38cf5cffd9c695f3ec` (origin/main). After source: the head commit of this pull request. Both captures ran against `test/fixtures/tui-host.mjs`: temporary agent folders, real SQLite stores, a scripted faux model and a fake CLI, with no real agents, credentials, wallets, model providers or marketplace servers. Chromium ran through Python Playwright at a 1440 x 1050 viewport with device scale 1. The screenshots hold synthetic data and a loopback address.

Scenario: seed ten operator turns on the fixture's `shop` agent, focus the empty composer, scroll to the page top, then admit one more message so a stream push rebuilds the page and hands the composer its focus back.

| Surface | Before | After |
| --- | --- | --- |
| Reader at the page top, push arrived, composer focused | [Before](composer-focus-before.png) | [After](composer-focus-after.png) |

Measured in the same scenario:

| Engine | Source | scrollY before push | scrollY after push | Focused element after push |
| --- | --- | --- | --- | --- |
| Chromium | before | 0 | 0 | composer textarea |
| Chromium | after | 0 | 0 | composer textarea |
| Firefox | before | 0 | 0 | composer textarea |
| Firefox | after | 0 | 0 | composer textarea |

## What the browsers showed, and what they could not

The yank the issue reports was observed at `52394dd`, before the composer became a card pinned to the bottom edge. At current main the pinned composer is in view at every scroll depth, so a plain `focus()` has nothing to scroll: Chromium and Firefox both keep the reader's place on either version, and the screenshots document that kept position rather than a visible delta. The change turns that layout luck into a stated guarantee (restored focus always passes `preventScroll`), keeps the deliberate jump scrolling, and scopes the query to the composer's own textarea. The unit tests are the behavioral pin, red on main's page script and green on this branch. The Briefing Goals trap is likewise test-pinned: reaching it from real clicks needs a pending composer focus while Briefing renders, and Chromium, Firefox and Playwright WebKit all blur the composer before the tab-switch render, so no browser capture of it is included.

## Local validation

| Command | Result |
| --- | --- |
| `pnpm exec vitest run test/console-page.test.ts` | 24 tests passed |
| `pnpm exec vitest run test/console-page.test.ts` with `src/console-page.ts` from origin/main | the three new focus cases fail |
| `pnpm check` | 335 tests in 25 files; TypeScript, skills, prose and lessons checks passed |
| `git diff --check` | passed |

## Reproduce locally

In a checkout of either version run `pnpm install --frozen-lockfile && pnpm build && node test/fixtures/tui-host.mjs`, open the printed console link and select `shop`. Post ten messages to `/api/agents/shop/messages` with unique requestIds to seed turns, click the composer, run `scrollTo(0, 0)` in the browser console, post one more message, and watch `scrollY` and `document.activeElement`. For the unit-level red and green: `git checkout origin/main -- src/console-page.ts && pnpm exec vitest run test/console-page.test.ts` fails the three new cases, and `git checkout HEAD -- src/console-page.ts` restores all 24 passing.

## Limits

All captures ran against the fixture host; no staging or production server was touched, and these checks say nothing about those environments. `preventScroll` support reaches Chrome 64, Firefox 68 and Safari 15.4; older engines ignore the option and keep today's behavior.
