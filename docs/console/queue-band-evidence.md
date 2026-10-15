# Queued-messages band evidence for #57

## Captured sources

| Capture | Source SHA | Image |
| --- | --- | --- |
| Before, empty queue | `7971e01ab9a06fe2ab1b9eb2ef94d1b1bf48c0d2` | [Before, empty](queue-band-before-empty.png) |
| Before, one queued follow-up | `7971e01ab9a06fe2ab1b9eb2ef94d1b1bf48c0d2` | [Before, queued](queue-band-before-queued.png) |
| After, empty queue | `64f8afa6facf56882f4f0dba2011c7c79d3fa1b5` | [After, empty](queue-band-after-empty.png) |
| After, one queued follow-up | `64f8afa6facf56882f4f0dba2011c7c79d3fa1b5` | [After, queued](queue-band-after-queued.png) |

Google Chrome 155.0.8059.39 rendered the real console through Python Playwright, at a 1440 by 1100 viewport, light theme, en-US locale and UTC timezone, with `bypass_csp` set as `.agents/lessons/console-evidence-playwright-csp.md` says. Each capture scrolled to the page bottom, where the queue sits above the composer. Neither source reported a page error.

Before, the empty queue shows the "Queued messages" band above the line "No queued messages." After, the empty queue shows nothing. In both sources the script then paused the shop and queued one follow-up through the console API. Before, the row appears under the yellow band. After, there is no band: the row is muted, with a dashed border and a faint "Queued" watermark behind its text. In both, the row appeared on the next stream update with no reload, and Playwright reported `#queued-messages` visible.

Only `test/fixtures/tui-host.mjs` ran. It creates temporary folders and real stores with a faux model and fake CLI. No model provider, marketplace server, real agent folder or wallet funds were used. The pictures contain synthetic fixture data only. The host stopped on SIGTERM and removed its temporary stores.

## Reproduce locally

In each source worktree, run `pnpm install --frozen-lockfile && pnpm build`, then `node test/fixtures/tui-host.mjs`. Open its printed console link without sharing the token and look at the bottom of the Timeline tab. Then POST `/api/agents/shop/paused` with `{"value":true}` and POST `/api/agents/shop/messages` with a `requestId` and `text`, using the same bearer token. Stop the fixture with SIGTERM.

For a self-verifying repro without a browser, run `pnpm exec vitest run test/console-page.test.ts`.

This is local fixture and browser evidence. It does not claim live staging or production validation.
