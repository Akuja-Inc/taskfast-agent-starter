# TUI startup evidence

These are unmodified X11 window captures of the TUI at clean implementation commit `89ff0ce735be3a5faa41487f60deface4d6cc866`, drawn by Bun/OpenTUI in Zutty and tmux. The synthetic loopback host is `docs/startup/browser-host.mjs`. No marketplace, provider, real agent folder or wallet was used. `tui-source.json` records the source hashes.

| State | Normal, 130 × 28 | Narrow, 90 × 28 |
| --- | --- | --- |
| Opening | [Screenshot](tui-starting-normal.png) | [Screenshot](tui-starting-narrow.png) |
| Failed | [Screenshot](tui-failed-normal.png) | [Screenshot](tui-failed-narrow.png) |
| Waiting for close | [Screenshot](tui-waiting-normal.png) | [Screenshot](tui-waiting-narrow.png) |

Matching `.txt` captures preserve the terminal text. The environment banner stays visible in each state. Opening and waiting for close offer `x` to cancel startup; while waiting, cancellation removes the queued open intention and lets cleanup finish. Stopped shows the failure reason and `R` to retry. `<` and `>` keep agent switching available throughout.

## Validation

`pnpm exec vitest run test/tui.test.ts` passed all 18 tests. The pure tests cover switching without a live view, busy/stopped startup action routing, waiting-for-close cancellation, blocked message sends, legacy roster normalization and stale-generation rejection.

`pnpm tui:test` passed the TUI TypeScript check and all 11 smoke tests. The startup smoke case uses a synthetic loopback HTTP server with a ready view from the existing throwaway host. It verifies cancel request deduplication, generation-bound retry payloads, switching to a healthy agent during a pending request, draft restoration, independent roster refresh, ID-based selection through roster reordering and rejection of a delayed old-generation view. A second regression delays successful message acknowledgements until after an agent switch. It checks that the accepted draft and attempt are cleared, another agent's draft stays intact, and newer unsent text survives. Existing message, queue, withdrawal, Briefing, help and disconnected-host checks still pass.

Reproduce with `pnpm build && python3 docs/startup/tui-capture.py` from the repository root. The capture needs an available X11 display, tmux, Zutty and ImageMagick; this run used Xvfb at `DISPLAY=:99`. It refreshes all six screenshots, matching text captures and `tui-source.json` with the current HEAD and source hashes.

The screenshots cover startup states only. The existing smoke harness verifies ready-agent interaction; this does not establish live staging or production behavior.
