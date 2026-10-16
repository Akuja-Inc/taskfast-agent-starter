# Browser startup evidence

The console keeps its existing yellow bands, black header, environment banner and two themes. Starting and stopped folders have an explicit status, a folder identifier and Cancel startup or Retry startup. Their drafts stay in memory and cannot be sent. A one-second roster poll runs independently of the selected ready agent's detail request and stream.

## Reproduce

```sh
pnpm exec vitest run test/console-page.test.ts
pnpm build
python3 docs/startup/capture.py
```

The capture uses machine-installed Python Playwright and `/snap/bin/chromium`. `browser-host.mjs` serves the built page and synthetic starting, stopped and healthy roster entries on loopback. It opens no agent folder, store, provider or marketplace connection. Retry and cancel acknowledgements wait 500 ms in this fixture so immediate local busy feedback is observable. That delay is not a host-performance measurement.

The browser checks draft retention across polling and folder switches, blocked Enter/Ctrl+S admission before readiness, focusable busy controls, retry/cancel transitions, a usable healthy agent, navigation, theme switching, horizontal overflow and 44px control heights. Screenshots cover 1440×1000 desktop and an emulated 390×844 phone viewport, in light and dark. This is Chromium evidence, not a physical-device or cross-browser claim.

## Before

`web-before-desktop-light.png`, `web-before-desktop-dark.png` and `web-before-phone-light.png` copy the committed ready-state captures from `docs/withdraw/web-after-*.png`. `before-source.json` preserves their original provenance, source commit `ab49780716b1808bf511918763d5c68dfb8e5304`. The page source hash in that record matches this change's base page at `c3c71394ad4323f88e297a118522fca141c95b09`. These show the incumbent visual language, not a simulated old startup screen.

## After

| State | Desktop light | Desktop dark | Phone light | Phone dark |
| --- | --- | --- | --- | --- |
| Starting | [Image](web-starting-desktop-light.png) | [Image](web-starting-desktop-dark.png) | [Image](web-starting-phone-light.png) | [Image](web-starting-phone-dark.png) |
| Stopped | [Image](web-stopped-desktop-light.png) | [Image](web-stopped-desktop-dark.png) | [Image](web-stopped-phone-light.png) | [Image](web-stopped-phone-dark.png) |

`browser-source.json` records the exact source hashes and whether the capture used uncommitted changes. Rerun the capture after the implementation commit to pin the final source SHA. Initial visual review inspected desktop and phone captures in both themes in one batch. The layout retained the incumbent style, readable status and usable controls without horizontal overflow; no visual correction was required.

These captures exercise the browser against the synthetic API contract. Host startup, MCP cleanup, persistent ownership, live staging and production are not established by this fixture.

## Host state transitions

The host owns these transient states. They never replace the permanent store or its action ledger. Each attempt carries a monotonically increasing generation for the current host lifetime. Browser and TUI requests must name the selected folder and generation.

| Current state | Event | Next state | Admission and cleanup |
| --- | --- | --- | --- |
| Starting | Open succeeds | Ready | Attach its event listener, then poll independently. Only now expose operator controls. |
| Starting | Validation or connection fails | Stopped | Show the reason; other slots continue. No model message was admitted. |
| Starting | Cancel | Stopped, new generation | Acknowledge intent immediately, abort opening and close any late handle before retrying. |
| Stopped | Retry | Starting, new generation | Wait for the preceding cleanup, then re-read that folder. A duplicate or stale intent conflicts. |
| Stopped | Prior cleanup failed | Stopped | Refuse reopening rather than assume ownership was released. |
| Ready | Session fails | Stopped | Stop its stream before closing its store. Keep siblings running. |
| Ready | Briefing save | Starting, new generation | Serialize the save with lifecycle intent; close the old owner before opening the replacement. |
| Reopening | Open fails | Stopped | Restore both saved files; do not silently restart the rolled-back configuration. |
| Any | Host shutdown | Closed | Reject new intent, abort openings, stop streams and drain owned cleanup. |

The console remains available with all slots stopped. Without `--console`, the host returns an error if no initial attempt opened an agent. Cancel does not erase state or cancel a marketplace action that was already dispatched. Retry startup never retries an interrupted MCP or marketplace tool call.

## Regression commands

```sh
pnpm vitest run test/console-host.test.ts test/console-startup.test.ts test/kit.test.ts test/event-lifecycle.test.ts
pnpm check
pnpm tui:test
```

Host tests hold one opening or enrichment request pending while asserting that the console and a healthy sibling remain usable. They also cover late results, stale and duplicate generations, configuration re-read, failed cleanup, Briefing rollback, shutdown and real persistent-store stream ordering. The new API tests reject pending-agent message admission and preserve token/origin checks. No live service is used.
