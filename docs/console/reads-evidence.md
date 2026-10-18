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
