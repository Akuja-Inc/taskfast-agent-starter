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

## Order feedback (#121)

Each order change now reports in a status line inside the orders block. Adding an order says so and keeps focus on the cleared input; the before page kept the old list while the input held focus. Removing one offers Undo, which adds it back at the end of the list. A stale removal says the list changed and shows the current orders beside the list, where the before page put a page-wide error. The capture runs add, remove and a stale remove on the same page, in that order.

```bash
python3 docs/console/reads-capture.py feedback
```

| | Before | After |
| --- | --- | --- |
| Added, light | ![before](settings-feedback-added-before-light.png) | ![after](settings-feedback-added-after-light.png) |
| Added, dark | ![before](settings-feedback-added-before-dark.png) | ![after](settings-feedback-added-after-dark.png) |
| Removed with Undo, light | ![before](settings-feedback-removed-before-light.png) | ![after](settings-feedback-removed-after-light.png) |
| Removed with Undo, dark | ![before](settings-feedback-removed-before-dark.png) | ![after](settings-feedback-removed-after-dark.png) |
| Stale remove, light | ![before](settings-feedback-stale-before-light.png) | ![after](settings-feedback-stale-after-light.png) |
| Stale remove, dark | ![before](settings-feedback-stale-before-dark.png) | ![after](settings-feedback-stale-after-dark.png) |

## Edit an order in place (#123)

Each order row gains a pencil square to the left of its X. The pencil opens the row as an input holding the raw markdown, with Save and Cancel. Save sends `PUT orders/N` with the text the row started from, so the order keeps its position and no turn runs without it.

```bash
python3 docs/console/reads-capture.py edit
```

| | Before | After |
| --- | --- | --- |
| Desktop light | ![before](settings-edit-before-desktop-light.png) | ![after](settings-edit-after-desktop-light.png) |
| Desktop dark | ![before](settings-edit-before-desktop-dark.png) | ![after](settings-edit-after-desktop-dark.png) |
| Phone light | ![before](settings-edit-before-phone-light.png) | ![after](settings-edit-after-phone-light.png) |
| Phone dark | ![before](settings-edit-before-phone-dark.png) | ![after](settings-edit-after-phone-dark.png) |
| Editing | | ![light](settings-edit-editing-light.png) ![dark](settings-edit-editing-dark.png) |
| Saved | | ![light](settings-edit-saved-light.png) ![dark](settings-edit-saved-dark.png) |

## Edit and remove the agent's notes (#125)

The agent's notes take the same pencil and X squares as orders. The block head says the agent adds them and the owner can edit or remove them. A note write waits until the agent finishes its current turn, and the status line says so while it waits. The capture host holds one write for three seconds to show that wait; the real host's wait is covered by `test/console-host.test.ts`. A removal offers Undo, which adds the note back at the end through the owner's write path.

```bash
python3 docs/console/reads-capture.py notes
```

| | Before | After |
| --- | --- | --- |
| Desktop light | ![before](settings-notes-before-desktop-light.png) | ![after](settings-notes-after-desktop-light.png) |
| Desktop dark | ![before](settings-notes-before-desktop-dark.png) | ![after](settings-notes-after-desktop-dark.png) |
| Phone light | ![before](settings-notes-before-phone-light.png) | ![after](settings-notes-after-phone-light.png) |
| Phone dark | ![before](settings-notes-before-phone-dark.png) | ![after](settings-notes-after-phone-dark.png) |
| Editing a note | | ![light](settings-notes-editing-light.png) ![dark](settings-notes-editing-dark.png) |
| Waiting for the turn | | ![light](settings-notes-waiting-light.png) ![dark](settings-notes-waiting-dark.png) |
| Removed with Undo | | ![light](settings-notes-removed-light.png) ![dark](settings-notes-removed-dark.png) |

## Edit the spending limits in the card (#127)

The per-job and daily limits move out of the agent.json form into the Limits card. Each row's pencil turns its value into a dollar input; empty means no limit. Any change shows the Confirm spending change note in the card, and clearing a limit adds the no-cap warning. The card's own Confirm, save & reopen sends only the limits, pinned to the limits it rendered.

```bash
python3 docs/console/reads-capture.py limits-edit
```

| | Before | After |
| --- | --- | --- |
| Desktop light | ![before](settings-limits-edit-before-desktop-light.png) | ![after](settings-limits-edit-after-desktop-light.png) |
| Desktop dark | ![before](settings-limits-edit-before-desktop-dark.png) | ![after](settings-limits-edit-after-desktop-dark.png) |
| Phone light | ![before](settings-limits-edit-before-phone-light.png) | ![after](settings-limits-edit-after-phone-light.png) |
| Phone dark | ![before](settings-limits-edit-before-phone-dark.png) | ![after](settings-limits-edit-after-phone-dark.png) |
| Per job edited, desktop | | ![light](settings-limits-edit-edit-desktop-light.png) ![dark](settings-limits-edit-edit-desktop-dark.png) |
| Per job edited, phone | | ![light](settings-limits-edit-edit-phone-light.png) ![dark](settings-limits-edit-edit-phone-dark.png) |
| Daily cleared, desktop | | ![light](settings-limits-edit-clear-desktop-light.png) ![dark](settings-limits-edit-clear-desktop-dark.png) |
| Daily cleared, phone | | ![light](settings-limits-edit-clear-phone-light.png) ![dark](settings-limits-edit-clear-phone-dark.png) |
