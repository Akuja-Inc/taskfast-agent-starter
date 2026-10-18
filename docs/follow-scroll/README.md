# Console timeline follow scrolling

Issue #116 makes the web console timeline follow new turns like a chat: a pushed turn scrolls into view while the reader is at or near the bottom, and the operator's own send always scrolls into view once it renders. A reader scrolled up keeps the reading anchor and gets the "Jump to the newest turn" button instead. A push that adds no turn (a status or queue update) never moves the page.

The follow decision is measured from live geometry before each render rebuilds the page, not from the `body.away` class: the class updates through `requestAnimationFrame`, so a push landing in the same frame as the reader's scroll-away would otherwise read a stale "at bottom" and pull the page down. The send follow survives the admission echo arriving before or after the POST resolves, and the render right after a follow skips the anchor restore once, because a `scrollBy` restore cancels an in-flight smooth scroll.

## Lifecycle and failure coverage

| State and input | Outcome | Local regression test |
| --- | --- | --- |
| Push while at the bottom | Newest turn and send note scroll into view with `smooth()` (reduced motion gets `auto`) | `follows a pushed turn while the reader is at the bottom, and ignores status-only pushes` |
| Push with no new turns | No scroll | same test, queue-only push |
| Push while scrolled up | Reading anchor held, jump button stays visible | `holds the reading anchor when a turn arrives while the reader is scrolled up` |
| Operator sends from any position | Sent message scrolls into view; composer focus restores with `preventScroll` (#30 unchanged) | `scrolls an admitted send into view from any position while focus restores without scrolling` |
| Deep link to a tool-call or raw-event panel | Opens at that panel, not at the bottom (#108, #109 unchanged) | `retains a linked action while its agent starts and resolves it when ready` |

Run the focused reproduction:

```bash
pnpm exec vitest run test/console-page.test.ts
```

## Browser evidence

The capture script serves the real compiled page against a synthetic loopback API whose stream accepts pushed turns and admits sends. It checks the initial open at the bottom, a followed push at the bottom, an anchored push while scrolled up with the jump button visible, and a send that scrolls into view from a scrolled-up position. It does not establish host behavior; the fake-DOM tests and the existing host tests cover that separately.

Reproduce with machine-installed Python Playwright and Chromium:

```bash
pnpm build
python3 docs/follow-scroll/capture.py
```

`browser-source.json` records the exact source commit, before commit and source hashes. The before page comes from that base commit; both pages use identical synthetic data. The after captures show the followed push and the sent message in view.
