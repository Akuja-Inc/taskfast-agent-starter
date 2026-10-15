# Queued-messages band evidence for #57

## Captured sources

| Capture | Source SHA | Image |
| --- | --- | --- |
| Before, empty queue | `7971e01ab9a06fe2ab1b9eb2ef94d1b1bf48c0d2` | [Before, empty](queue-band-before-empty.png) |
| Before, one queued follow-up | `7971e01ab9a06fe2ab1b9eb2ef94d1b1bf48c0d2` | [Before, queued](queue-band-before-queued.png) |
| After, empty queue | `bed8bf2fc56961e760308e8cd450e95c77189b31` | [After, empty](queue-band-after-empty.png) |
| After, one queued follow-up | `bed8bf2fc56961e760308e8cd450e95c77189b31` | [After, queued](queue-band-after-queued.png) |
| After, three queued rows, light | `bed8bf2fc56961e760308e8cd450e95c77189b31` | [After, three, light](queue-band-after-three-light.png) |
| After, three queued rows, dark | `bed8bf2fc56961e760308e8cd450e95c77189b31` | [After, three, dark](queue-band-after-three-dark.png) |

Google Chrome 155.0.8059.39 rendered the real console through Python Playwright, at a 1440 by 1100 viewport, light theme, en-US locale and UTC timezone, with `bypass_csp` set as `.agents/lessons/console-evidence-playwright-csp.md` says. Each capture scrolled to the page bottom, where the queue sits above the composer. Neither source reported a page error.

Before, the empty queue shows the "Queued messages" band above the line "No queued messages." After, the empty queue shows nothing. In both sources the script then paused the shop and queued one follow-up through the console API. Before, the row appears under the yellow band. After, there is no band: the row is muted, with a dashed border, a mode line that says the message waits until you resume, and a faint sentence-case "Queued" at the right end of the mode line. In both, the row appeared on the next stream update with no reload, and Playwright reported `#queued-messages` visible.

The three-row captures paused the shop and queued a follow-up, a steer and a 231-character follow-up, then took an element screenshot of `#queued-messages` in the light and dark themes. In both, the "Queued" mark sits clear of the message text and the Steer button. At a 390 by 844 viewport, measured but not committed, the mode line wraps before the reserved space and nothing overlaps. Chrome's accessibility tree reads "Queued" once per row, from the mode line, and never from the mark. No page errors were reported.

Only `test/fixtures/tui-host.mjs` ran. It creates temporary folders and real stores with a faux model and fake CLI. No model provider, marketplace server, real agent folder or wallet funds were used. The pictures contain synthetic fixture data only. The host stopped on SIGTERM and removed its temporary stores.

## Reproduce locally

In each source worktree, run `pnpm install --frozen-lockfile && pnpm build`, then `node test/fixtures/tui-host.mjs`. Open its printed console link without sharing the token and look at the bottom of the Timeline tab. Then POST `/api/agents/shop/paused` with `{"value":true}` and POST `/api/agents/shop/messages` with a `requestId` and `text`, using the same bearer token. Stop the fixture with SIGTERM.

For a self-verifying repro without a browser, run `pnpm exec vitest run test/console-page.test.ts`.

This is local fixture and browser evidence. It does not claim live staging or production validation.
