# Console URL navigation evidence

Issue: [#108](https://github.com/Akuja-Inc/taskfast-agent-starter/issues/108).

## Contract

The path identifies only an agent folder: `/agents/<folder-id>`. Query parameters identify the page (`tab`), every expanded tool-call group (`open`, repeated), every expanded raw event (`raw`, repeated), and capability destinations (`screen`, `item`, and a server wizard's `step`). The default page is Timeline. The default capability screen is its overview. A turn's opaque ID hashes its originating input and timestamp; tool-call groups also use the first call's ID. References never use a current row index. Duplicate references are unavailable rather than guessed.

Existing polling-run and per-check disclosures keep their local behavior. Opening a linked tool panel inside a folded check reveals its containing disclosures. Live refresh does not force a group the user subsequently closed to reopen. The folding classifier, result rendering, focus restoration and original history remain unchanged.

These are live navigation destinations, not snapshots or commands. They contain no credentials, draft message or configuration contents, uploads, test consent, or approvals. Capability restoration can read current configuration but cannot dispatch a mutation, run discovery, or read a CLI preview. An unsaved new connection's later wizard steps cannot be recovered from a link. Existing signing, policy, admission and MCP approval boundaries are unchanged.

The loopback HTTP server allows a bounded 128 KiB request-header budget, including the request URL. This lets a whole expanded transcript window reload instead of hitting Node's default 16 KiB limit. A regression sends 200 call-group and 200 raw-event references in one URL. No panel references are silently dropped.

The server keeps the latest 400 transcript entries. Links to older turns within that view mount the needed turns automatically. A reference outside the current view is explicitly unavailable. This change does not add history retrieval, remote access, stable ports, credential sharing, or snapshot export.

## Navigation transitions

| State and event | Result | Information retained | Side effects |
| --- | --- | --- | --- |
| Locked browser opens a destination | Unlock screen | Requested path and query | No mutation |
| Token refused, then valid token supplied | Same destination after unlock | Requested path and query | Authenticated reads only |
| Starting agent becomes ready | Resolve the retained destination | Page and all panel references | Existing roster and view reads |
| Clean agent, page or panel navigation | Push one history entry | Message drafts remain per-agent in memory | No marketplace mutation |
| Dirty configuration, navigation cancelled | Keep editor and URL, including when the agent stopped and its view disappeared | Unsaved fields and credential entries | Restore the current history entry after Back or Forward |
| Dirty configuration, navigation accepted | Discard editor and navigate | Saved configuration and existing message-draft behavior | No automatic save |
| Back or Forward accepted | Restore that entry's destination | Live data and represented expanded panels | No extra history entry |
| Reload then cancelled Back | Return to the original entry | Persisted browser entry index and dirty editor | No extra history entry |
| Live commit | Refresh current data | Destination and protected editor | No navigation entry |
| Unique panel reference | Mount and expand it | All other represented panels | No mutation |
| Missing or ambiguous reference | Destination unavailable | Requested URL | No fallback to another action |
| Missing agent or capability | Explicit unavailable state | Requested URL | User chooses another destination |
| Import or CLI-preview link reopened | Empty import or preview screen | Destination identity only | Selecting files or reading a bundle requires a deliberate action |

## Local validation

- `pnpm check` covers the route codec, the shipped page against a fake DOM, the real HTTP shell and security boundary, and stable timeline identities.
- `TASKFAST_BROWSER=/path/to/chromium pnpm exec vitest run test/console-navigation-browser.test.ts test/console-capabilities-page.test.ts` exercises the shipped page against real `startConsole` servers in Chromium. The new navigation suite covers older panels, copy and reload, live outcomes, separate unlock, failed authentication, dirty-edit cancellation across a reload boundary, capability steps, no automatic POSTs and unavailable destinations. Without `TASKFAST_BROWSER`, only the browser cases skip.
- `pnpm tui:test` verifies the existing terminal client against the additive timeline identity field.

No marketplace account, model provider, wallet, live store, staging server or production service was used. The fixtures supply scripted data and a public synthetic token.

## Captures

Baseline source: `321a4dca4009fe0786d3760a312146f7f61bc269`. After source: `1772b67cf1adb7f98a1c533be6dfa63b5f41238a`. The images are committed with this document and pinned to their evidence commit in the PR body.

The direct-link comparison requests `/agents/beta?tab=briefing` from each built host. The baseline does not serve the console at agent paths and returns its existing authentication error as JSON. The changed host serves the shell and opens Beta's Briefing after authentication. The expanded-panel captures open an Alpha timeline link with both `open` and `raw` references, without clicking a panel after arrival.

- [Before direct link](before-direct-link.png): baseline host, 1280 × 900.
- [After direct link](after-direct-link.png): Beta's Briefing, 1280 × 900.
- [Expanded panels](after-expanded-panels.png): restored raw event and tool-call group, 1280 × 900.
- [Phone](after-phone.png): same restored link, 390 × 844. Chromium viewport emulation, not a physical phone. The capture script checks horizontal overflow.

The fixture host is `test/fixtures/console-navigation-host.mjs`. Both checkouts must already have been built. With Python Playwright installed, reproduce the captures from the changed checkout:

```sh
TASKFAST_BROWSER=/path/to/chromium python3 scripts/capture-console-navigation.py --baseline /path/to/built-baseline-checkout
```

Capture automation bypasses CSP only in its browser context to drive the existing page. The served CSP remains unchanged. The capture process stops both fixture hosts before exiting.
