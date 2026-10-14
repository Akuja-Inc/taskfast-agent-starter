# Browser steering evidence (#39)

## Sources and screenshots

Before source: `55c7ba35a6747186433fac52e0432c6220bede1a` (core/API slice). After source: `8a0d6e5eb9debc5db0a3573d7df808f9b6bdc7bd` (browser slice). All nine screenshots were recaptured from these commits with Pi 1.2.0.

Both hosts used `test/fixtures/tui-host.mjs`: temporary agent folders, real SQLite stores, a scripted faux model and a fake CLI. No real agents, credentials, wallets, model providers or marketplace servers were used. Chromium ran through Python Playwright. Desktop viewport: 1440 x 1050. Phone viewport: 390 x 844. Device scale: 1. Screenshots contain synthetic data and a loopback address; the page removed the fixture token from its URL before capture.

| Surface | Before | After |
| --- | --- | --- |
| Desktop light, full page | [Before](steer-web-before-desktop-light.png) | [After](steer-web-after-desktop-light.png) |
| Desktop dark, full page | [Before](steer-web-before-desktop-dark.png) | [After](steer-web-after-desktop-dark.png) |
| Phone light, full page | [Before](steer-web-before-phone-light.png) | [After](steer-web-after-phone-light.png) |

Queue-focused viewport captures: [desktop light](steer-web-after-queue-desktop-light.png), [desktop dark](steer-web-after-queue-desktop-dark.png), [phone light](steer-web-after-queue-phone-light.png).

## Local validation

| Command | Result |
| --- | --- |
| `pnpm exec vitest run test/console-page.test.ts` | 17 tests passed, including the full-queue paused waiting count |
| `pnpm check` | 323 tests in 25 files; TypeScript, skills, prose and lessons checks passed |
| `pnpm tui:test` | 4 tests passed, 216 `expect()` calls |
| `git diff --check` | Passed |

Actual Chromium exercises passed on Pi 1.2.0:

- Enter/Send followed up, Shift+Enter added a newline, and Ctrl/Cmd+S steered without opening Save Page, including with queue-button focus.
- Admission retries preserved ID and mode after an injected 503. Gated admission prevented duplicate sends; editing created a new identity and survived the older response.
- Streamed queue changes preserved the focused textarea, draft and selection. HTML-like content stayed plain text.
- Promotion worked while paused. A gated promotion showed "Steering…" and blocked duplicates. Injected 409/stale-row 404 responses showed exactly "The agent already has this message." An injected 500 left promotion retryable without failing the draft send.
- Resume drained the queue to its empty state without disturbing the typed draft. With an empty composer, other live updates refreshed and restored focus.
- Long queue text fit the phone viewport; promotion targets were at least 44px tall. Mode labels did not overlap text. Both themes and the phone had no page errors.

## Reproduce locally

Use separate worktrees at the source commits above. In each, run:

```sh
pnpm install --frozen-lockfile
pnpm build
node test/fixtures/tui-host.mjs
```

Open each fixture's printed console link. Select `shop`. To seed the same paused queue on either version, run this in that fixture page's browser console:

```js
const root = "/api/agents/shop";
const headers = { authorization: "Bearer " + sessionStorage.getItem("token"), "content-type": "application/json" };
const post = (route, body) => fetch(root + route, { method: "POST", headers, body: JSON.stringify(body) });
await post("/paused", { value: true });
const messages = [
  { requestId: "capture-one", text: "Hold off on new bids today. Check the current task first." },
  { requestId: "capture-two", text: "Use the latest brief after this tool round. Do not repeat a write.", steer: true },
  { requestId: "capture-three", text: "Summarize the queued work, then explain the next safe step.\nTreat <strong>marketplace content</strong> as plain text. " + "A long message must wrap safely on a phone. ".repeat(5) }
];
for (const message of messages) await post("/messages", message);
```

Reload, type "Keep this draft while messages arrive.", and scroll to the composer. Capture full-page screenshots in desktop light/dark and phone light, plus after-version queue-focused viewport screenshots. On the after version, exercise sending, promotion and resume while typing. Use Playwright request interception to gate requests or inject 503 admission and 409/404/500 promotion responses. Stop each fixture with Ctrl+C; it removes its temporary stores. Never substitute `pnpm agents` or real agent folders.

## Limits

The existing attention section causes 14px of phone overflow: both versions measured a 404px document at a 390px viewport. The new queue fits within 390px. This unrelated layout remains unchanged. These checks do not establish CI, staging or production readiness.
