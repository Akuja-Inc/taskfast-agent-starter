# Wallet refresh evidence for #58

## Captured sources

| Capture | Source SHA | Web console | TUI |
| --- | --- | --- | --- |
| Before | `7971e01e371186d416faefe23cddeaa09b8f7ded` | [web](wallet-before-web.png) | [TUI](wallet-before-tui.png) |
| After | `1504e1c8819bb05763aa092d6dad2b383ccc0a34` | [web](wallet-after-web.png) | [TUI](wallet-after-tui.png) |

Each capture ran `docs/console/wallet-capture-host.mjs` from its source tree. The host opens one real store with a faux model and a fake CLI whose wallet reads 50.00 USDC. The capture waited until both the page and the TUI showed 50.00 USDC. It then sent SIGUSR2, which admits a `payment_released` event and moves the fake server balance to 68.00 USDC. Both pictures were taken about 5.4 seconds later. Before, both UIs still show 50.00 USDC next to the admitted event. After, both show 68.00 USDC with no reload.

System Chromium rendered the page through Python Playwright at 1440 by 1000, light theme, en-US and UTC. Zutty ran tmux and Bun/OpenTUI at 130 by 40, captured with ImageMagick `import -window`. The `wallet-*-tui.txt` files hold the same TUI panes as text and `wallet-*-source.json` records what each capture read.

No model provider, marketplace server, real agent folder or wallet funds were used. The model name shown is the example's, not a provider call. The console token stayed in memory. The host removed its temporary store at exit.

## Reproduce locally

From the repository root, run `pnpm install --frozen-lockfile && pnpm tui:test`, then `python3 docs/console/wallet-capture.py after`. For the before capture, check out the before SHA in a separate worktree, install and build it, run `bun install --frozen-lockfile` in its `src/tui/`, copy `docs/console/wallet-capture-host.mjs` into it, and run `python3 docs/console/wallet-capture.py before <that worktree>`. Without a browser or terminal, `pnpm exec vitest run test/console-host.test.ts` checks the same behavior.

This is local fixture evidence. It does not claim live staging or production validation.
