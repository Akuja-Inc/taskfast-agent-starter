# Folded polling evidence

This is browser-only display compression for issue #106. The owner selected Folded run and then approved the conservative first version: changed agent wording stays visible even when server data matches. There are no new model calls, prompt changes, polling changes or transcript rewrites.

## Reproduce

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
python3 docs/poll-folds/capture.py
pnpm tui:test
```

The capture needs machine-installed Python Playwright and its Chromium browser. It starts a loopback-only fixture that serves the built console page and synthetic console views. It opens no agent folder or store and calls no model or marketplace server. `BEFORE_REF=98f4246` supplies the original page for the before capture. The fixture uses `buildTimeline()` on synthetic transcripts, so completion and comparability metadata follow the real projection rather than hand-authored flags.

`capture.py` checks native disclosure expansion, original replies and tool results, group growth over the view stream, keyboard focus, reading position, pending-to-completed transitions, failures, changed results, changed reply wording, agent isolation, initial window clipping, historical loading and rail navigation. It checks phone and desktop widths in both themes, horizontal overflow and the summary's 44px minimum height. These are local fixture checks, not live staging or production validation.

## Captures

- [Before, desktop light](before-desktop-light.png)
- [After, desktop light](after-desktop-light.png)
- [After, desktop dark](after-desktop-dark.png)
- [After, phone light](after-phone-light.png)
- [After, phone dark](after-phone-dark.png)
- [Expanded checks and original tool result](after-expanded.png)

`browser-source.json` records the source commit, before commit and source-file hashes. The screenshots use synthetic values. The frozen budget and readiness controls are existing console components, not part of the folding change.

## Eligibility and boundaries

| Observation | Browser display |
| --- | --- |
| First supported completed check | Original turn; establishes baseline |
| Same input, exact reply text, same ordered successful reads and request scopes, canonically equal complete JSON results | Folded run; retains every original |
| Same responses but different reply wording | Original turn |
| Changed task state, amount, deadline, cursor, result order or request filter | Original turn |
| Pending, failed, uncertain, cancelled or truncated work | Original turn |
| Write, money, memory, skill or MCP tool | Original turn |
| Unsupported response, missing completion/comparability metadata, non-JSON, oversized or excessively nested result | Original turn |
| Operator input, marketplace event or resumed work | Original turn; breaks the run |

Every response field participates in comparison. Object key ordering is incidental; array ordering and response timestamps are not discarded. Comparison is limited to an explicit marketplace-read allowlist. No new tool becomes eligible automatically. Null or scalar responses and empty objects remain unfolded. The summary names only the reads performed, never the whole marketplace.

The browser clips groups to mounted originals and keeps one rail mark per original turn. Group, check and tool-control identities include the agent, generation and original timestamp/call identity rather than mutable transcript indices. An original that finishes while its tool control is focused stays revealed when it becomes eligible for folding.

The console API gains optional completion/comparability metadata but retains its full original timeline. The terminal UI ignores these fields and remains unfolded. Persisted conversation, events, policy and spending state are unchanged; the new classifier is a pure display projection, tested against an unchanged source-history copy.
