# Core/API steering evidence for #39

## Captured sources

| Capture | Source SHA | Image |
| --- | --- | --- |
| Before | `a86e824ef573840d47b9f0ba471b99b7459d1945` | [Before](steer-api-before.png) |
| After | `16e59528dab1225d729220bf4a78967741da1c85` | [After](steer-api-after.png) |

System Chromium 155.0.8059.39 rendered the real console through Python Playwright, at a 1440 by 1100 viewport, light theme, en-US locale and UTC timezone. Both captures show the paused shop with two queued operator messages. Neither page reported a browser error. Screenshots are byte-identical, as expected: this API-only slice does not change the page. They prove rendering, not a new browser control.

Only `test/fixtures/tui-host.mjs` ran. It creates temporary folders and real stores with a faux model and fake CLI. No model provider, marketplace server, real agent folder or wallet funds were used. The displayed example model name does not mean a provider call occurred. Tokens stayed in memory and browser session storage; the pictures contain synthetic fixture data only. Hosts stopped and temporary stores were removed after capture.

## Actual API results

The baseline returned 204 when paused and when each of two follow-ups was admitted. Its view showed two buffered messages, with no `queuedMessages` field.

The after source returned 200 with two queued messages, both `followUp`. `POST /api/agents/shop/steer/gh39-proof-1` returned 204. The next GET returned 200 with the first message in `steer` mode and the second still `followUp`. The operator stayed paused and neither message ran.

## Reproduce locally

In each isolated source worktree, run `pnpm install --frozen-lockfile && pnpm build`, then `node test/fixtures/tui-host.mjs`. This host uses only temporary data and synthetic boundaries. Open its printed console link without sharing the token, pause the shop, and send two messages with distinct request IDs. Read `/api/agents/shop`, POST `/api/agents/shop/steer/<requestId>`, then read the queue again, using the same bearer token for each API request. Capture the page in a browser and stop the fixture with SIGTERM so its stores are removed.

Both captures were rebuilt and exercised on the pinned Pi 1.2.0 packages. For a self-verifying repro without a browser, run `pnpm exec vitest run src/core/operator.test.ts src/core/steering.test.ts test/console.test.ts`. This recapture also ran that command: 3 files and 51 tests passed. The parent separately reports 25 files and 311 tests plus 4 Bun smoke tests and 219 assertions passing on Pi 1.2.0.

This is local fixture and browser evidence. It does not claim live staging, production or power-loss validation.
