# Settings captures

[reads-capture.py](reads-capture.py) serves the compiled console page against [reads-host.mjs](reads-host.mjs), a synthetic loopback host with no agent folder, store, model or marketplace call. It captures Settings before and after one change, in light and dark, at desktop (1440x1000) and phone (390x844) width. The before page is `src/console-page.ts` at the scenario's base commit, transpiled from git. Each scenario writes `settings-<scenario>-source.json`, which records the capture commit, the base commit and the SHA-256 of every capture source.

```bash
pnpm build
python3 docs/console/reads-capture.py reads
```

## reads (#122)

Settings shows what the agent reads every turn as three owned blocks in prompt order: your instructions, the agent's notes, your standing orders. Order text renders its bold and links. Each order has an X action square in place of the outline Remove button. The raw prompt sits behind "Show the exact text the model reads" instead of in the sidebar.

| | Before | After |
| --- | --- | --- |
| Desktop light | ![before](settings-reads-before-desktop-light.png) | ![after](settings-reads-after-desktop-light.png) |
| Desktop dark | ![before](settings-reads-before-desktop-dark.png) | ![after](settings-reads-after-desktop-dark.png) |
| Phone light | ![before](settings-reads-before-phone-light.png) | ![after](settings-reads-after-phone-light.png) |
| Phone dark | ![before](settings-reads-before-phone-dark.png) | ![after](settings-reads-after-phone-dark.png) |
| Raw prompt open | | ![light](settings-reads-raw-light.png) ![dark](settings-reads-raw-dark.png) |

## Limits card (#120)

Settings gains a Limits card in its sidebar, "enforced by code", showing the saved per-job and daily caps or "No limit". With neither limit set, an amber note says nothing caps the agent. An empty orders block teaches what an order is and offers the role's samples. A draft order that names a dollar amount shows the hint that nothing enforces it. The timeline sidebar shows one muted line instead of an empty orders card.

```bash
python3 docs/console/reads-capture.py limits-empty
python3 docs/console/reads-capture.py limits-set
```

| | Before | After |
| --- | --- | --- |
| No orders, no limits, desktop light | ![before](settings-limits-empty-before-desktop-light.png) | ![after](settings-limits-empty-after-desktop-light.png) |
| No orders, no limits, desktop dark | ![before](settings-limits-empty-before-desktop-dark.png) | ![after](settings-limits-empty-after-desktop-dark.png) |
| No orders, no limits, phone light | ![before](settings-limits-empty-before-phone-light.png) | ![after](settings-limits-empty-after-phone-light.png) |
| No orders, no limits, phone dark | ![before](settings-limits-empty-before-phone-dark.png) | ![after](settings-limits-empty-after-phone-dark.png) |
| Orders and limits, desktop light | ![before](settings-limits-set-before-desktop-light.png) | ![after](settings-limits-set-after-desktop-light.png) |
| Orders and limits, desktop dark | ![before](settings-limits-set-before-desktop-dark.png) | ![after](settings-limits-set-after-desktop-dark.png) |
| Orders and limits, phone light | ![before](settings-limits-set-before-phone-light.png) | ![after](settings-limits-set-after-phone-light.png) |
| Orders and limits, phone dark | ![before](settings-limits-set-before-phone-dark.png) | ![after](settings-limits-set-after-phone-dark.png) |
| Money hint | | ![light](settings-limits-empty-money-light.png) ![dark](settings-limits-empty-money-dark.png) |
| Timeline sidebar, no orders | | ![light](settings-limits-empty-timeline-light.png) ![dark](settings-limits-empty-timeline-dark.png) |

The terminal UI captures come from [docs/tui/orders-capture.py](../tui/orders-capture.py): real OpenTUI output in Zutty against `test/fixtures/tui-host.mjs`, with the before run from a worktree at the base commit.

| | Before | After |
| --- | --- | --- |
| Empty orders | ![before](../tui/orders-empty-before.png) | ![after](../tui/orders-empty-after.png) |
| Order naming $5 | ![before](../tui/orders-money-before.png) | ![after](../tui/orders-money-after.png) |
