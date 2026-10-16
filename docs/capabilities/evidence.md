# Capability console evidence

All screenshots come from the shipped console served on loopback with two temporary agent folders, real SQLite stores, a faux model and a stubbed TaskFast command. Nothing reads a real agent folder. No account setup, wallet operation, live model request, marketplace request or third-party MCP service is involved.

## Capture provenance

The before source is `6bf5d7451c96`, the parent of this stack. The after source is `4a7d37f`, including the full-revision phone-wrap regression fix. The JSON manifests record the complete source hashes. Screenshots are committed separately from their source so the manifests do not require a circular commit hash.

| Files | What they show | Source manifest |
| --- | --- | --- |
| `before-desktop-light.png`, `before-desktop-dark.png` | Existing Briefing at 1440 × 1000 before Capabilities exists | `before-source.json` |
| `before-phone-light.png`, `before-phone-dark.png` | Existing Briefing at 390 × 844 | `before-source.json` |
| `after-desktop-light.png`, `after-desktop-dark.png` | Side-by-side Skills and MCP areas at 1440 × 1000 | `after-source.json` |
| `after-phone-light.png`, `after-phone-dark.png` | Stacked sections and wrapped full SHA-256 revisions at 390 × 844 | `after-source.json` |
| `after-consent-phone-light.png` | Real local executable, arguments, directory and credential names before consent, with Test disabled | `browser-smoke-result.json` |
| `after-review-desktop-light.png` | One shared skill, server, exact tool fingerprint and credential-operation review | `browser-smoke-result.json` |
| `after-connected-desktop-light.png` | Applied skills, one approved MCP read and separate live connection health | `browser-smoke-result.json` |

All captures are full page from the document top. The evidence scripts assert that no horizontal overflow or page-script errors occur. Paths in the consent capture belong to the synthetic local fixture, not a portable executable promise. They deliberately wrap instead of hiding execution details. The credential value is invented, masked during entry, absent from views and never retained in browser storage.

## Reproduce

```bash
pnpm build
python3 docs/capabilities/capture.py after
python3 docs/capabilities/browser-smoke.py
TASKFAST_BROWSER=/snap/bin/chromium pnpm check
pnpm tui:test
```

The capture scripts use the Chromium already installed on this machine and Python Playwright. They do not install browser packages. Supply an equivalent installed browser path on another machine. Upload staging lives briefly under the checkout so a confined browser can read the selected directory; the script removes it in `finally`.

The browser smoke test imports a skill, enters a private binding, checks that discovery is disabled before consent, discovers the local stdio fixture, confirms that known writes stay blocked and nothing is preselected, approves only `search`, reviews the shared batch, and applies it. The held replacement opens only after the old run is idle. Its new model work starts only after the journal commits. The faux model then invokes `mcp_sources_search` through the real durable conversation. The test reads its stored transcript and verifies the result, zero marketplace actions, live connection health and isolation from the sibling agent.

Chromium unit coverage also checks stale revisions, late responses, focus retention, private-field clearing, pending-item discard, TaskFast preview, exact tool-diff review, stopped-agent removals after browser reload, phone layout and field-linked errors. Backend and host tests cover real persistent-store reopens, interrupted publication, rollback conflicts, request deduplication, cancellation, a current write finishing as done rather than uncertain, and stream-first shutdown during a hung apply.

## Results

- Isolated backend PR: `pnpm check`, 35 files and 590 tests passed.
- Full web stack: `TASKFAST_BROWSER=/snap/bin/chromium pnpm check`, 37 files and 610 tests passed, including actual Chromium rather than skipped browser tests.
- `pnpm tui:test`: 11 tests passed.
- `python3 docs/capabilities/browser-smoke.py`: passed with an actual approved local MCP read in the durable transcript.
- Non-mutating installed CLI preview: TaskFast 0.19.7, seven files, `SKILL.md` SHA-256 `8732dbba4a8bcb781a9055adfab44cd945b3799e51806798b9db0fdcb312b7a7`, no pending changes. This is local bundle export, not marketplace validation.

A separate adversarial lifecycle pass reproduced two races during development: a replacement recovering work before publication committed, and manager shutdown delaying sibling stream closure. Regression tests now hold replacement scheduling until commit and close all streams before awaiting manager shutdown. The independent recheck found both counterexamples fixed.
