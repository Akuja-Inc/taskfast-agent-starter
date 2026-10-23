# The Durable Object host

This is how one owner's agent runs on their own Cloudflare account (#144). It covers the Durable Object (DO) host, the Access check, the CLI Container for every marketplace command, and marketplace events by webhook. The console is read-only. Nothing here has run on a deployed Cloudflare account yet.

## Parts

- **The Worker** (`cloudflare/src/worker.ts`) receives every request. `gate()` in `cloudflare/src/gate.ts` checks the Cloudflare Access token, then the console token, before any DO is touched.
- **The Agent DO** owns the agent's store. `agentHost()` in `cloudflare/src/host.ts` opens it with `openMarketplaceAgent`, on the DO's SQLite storage through Pi's `openDurableObjectSqliteStorage`. A DO is single-instance, so it takes the place of the local owner lock.
- **The CLI Container** (`cloudflare/cli/`) runs the pinned `taskfast` release behind `GET /health` and `POST /run`. Each call gets a fresh folder holding the agent's TaskFast config and, for a signing command only, the keystore and password, laid out as `.taskfast/wallet.json` and `.taskfast/wallet-password`. The Container deletes the folder afterwards. Only the Agent DO's binding reaches it.
- **The marketplace path** is `containerCommand()` in `cloudflare/src/container.ts`. It sends only the commands the kit sends (`COMMANDS`: every tool's, plus policy's upload cleanup and the bond token read) and refuses anything else before it leaves the DO. It sends the wallet only with `post`, `settle`, `escrow sign` and `bond post`, the commands `signs()` in `src/core/cli.ts` names. It maps the CLI's stdout with the same `cliOutcome` as the local host, so `REFUSED` keeps its meaning.

Secrets, set with `wrangler secret put`: `CONSOLE_TOKEN` (64 hex characters, the console page's bearer token), `TASKFAST_CONFIG` (the text of the agent's `.taskfast/config.json`) `WEBHOOK_SECRET` (the signing secret `taskfast webhook register` returns once), `MODEL_SETTINGS` (a JSON object of provider settings, like the folder's `.env`), and `WALLET_KEYSTORE` and `WALLET_PASSWORD` (the text of `.taskfast/wallet.json` and the one-line password) for an agent that signs. Signing needs `keystore_path` set to `.taskfast/wallet.json` in the config. Vars in `wrangler.jsonc`: `AGENT_ID`, `CLI_ENV` (`prod`, `staging` or `local`), `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. The owner's `agent.json` and `INSTRUCTIONS.md` go in the git-ignored `cloudflare/agent/` folder and are bundled at deploy.

A provider setting that names a file, such as a Google Vertex credentials file, does not work from a secret. Use a provider whose key is a plain setting. Artifacts need no R2. Policy writes a submit's text files to `/tmp/agent/.pi-state/artifacts/` in the DO just before dispatch. `containerCommand` reads each `--artifact` file there and sends it in the call body, and the Container writes it into the per-call folder. Five text files of 256 KiB fit in the Container's 2 MiB body limit. A DO's `/tmp` is memory and is lost on eviction, but the files only live between policy's write and the dispatch in one tool call; an eviction there is the `uncertain` path. Binary `media:` files cannot occur: they come from approved MCP tools, and this host connects no MCP server. Durable storage such as R2 becomes necessary only when remote MCP is wired in, because a media handle must outlive a turn.

## DO lifecycle

| State | Event | Outcome | Test |
|---|---|---|---|
| New instance | Constructor | Sets an alarm for now if none is set | `smoke.mjs` (local workerd) |
| New instance | First request or alarm | Loads the spec and secrets, opens the store, runs `policy.initialize`, which reads `me` and binds identity | `host.test.ts` "opens the store once" |
| Opening | A second request arrives | Waits for the same open; the store opens once | `host.test.ts` "opens the store once" |
| New instance | A secret is missing or malformed, or `me` fails | Stopped with the reason; the roster shows it, the view answers 409 | `host.test.ts` "shows a stopped agent"; `smoke.mjs` |
| Stopped | Next request or alarm | Tries to open again | `host.test.ts` "shows a stopped agent" |
| Stopped | Alarm | Retries in 60 s. A misconfigured deployment wakes once a minute until it is fixed | `host.test.ts` "shows a stopped agent" |
| Open | Alarm | `ping()`, then waits until idle inside the alarm, then schedules the next check after `pollIntervalMinutes` | `host.test.ts` "runs one work check" |
| Open, paused | Alarm | `ping()` starts no turn; reschedules | covered by `ping()` in `src/core/agent.ts` |
| Open | The model calls a write | Policy reserves, then the Container runs it once; a CLI refusal releases it as `failed` | `host.test.ts` "runs one work check" |
| Open | A command the kit never sends | `failed` before anything leaves the DO | `container.test.ts` "refuses a command the kit never sends" |
| Open | A signing command with no wallet secrets | `failed` (`keystore`) before anything leaves the DO | `container.test.ts` "refuses a signing command" |
| Reserved | The Container is cold or fails its health check | `failed` before the command leaves the DO; policy releases the reservation | `container.test.ts` "is a known refusal" |
| Reserved | Health passed, then the request fails, answers non-2xx or is unreadable | `uncertain`, spent, never replayed | `container.test.ts` "is uncertain when" |
| Reserved | The CLI cannot reach TaskFast (`network`, exit 6) | `uncertain`, spent, never replayed | `container.test.ts`; `spikes/cloudflare/cli/parity.mjs` |
| Reserved | The CLI refuses (`validation`, exit 7) | `failed`; policy releases it | `container.test.ts`, `host.test.ts` |
| Open | Session fails | Stopped with the reason; the next request reopens | `host.ts` (`closed` handler) |
| Evicted between reservation and dispatch | Next instance opens | `policy.initialize` turns `reserved` into `uncertain`, counted as spent, never re-sent | core policy tests; a deployed eviction has not run |
| Evicted mid-turn | Next instance opens | The conversation resumes from Pi's store; the alarm runs the next check | `spikes/cloudflare/restart-proof.mjs` |
| Open | Alarm cut off by a deploy or its 15-minute wall-time limit | The alarm set a retry in 60 s before the turn started, so the next check still runs | not run; needs a deploy |
| Restarted | Owner reads | The same ledger and transcript | `smoke.mjs` restart rows |

The Container library retries only its readiness ping (`waitForPort`), never a proxied request: `containerFetch` sends each request once. So a write cannot be sent twice under one dispatch.

## Access and the console token

| Request | Outcome | Test |
|---|---|---|
| No `Cf-Access-Jwt-Assertion` header | 403; no DO is touched | `gate.test.ts`, `smoke.mjs` |
| Malformed token, `alg` other than RS256 | 403 | `access.test.ts` |
| Signed by an unknown key or another key | 403; an unknown key ID refetches the team's keys once | `access.test.ts` |
| Expired, or not valid yet | 403 | `access.test.ts`, `smoke.mjs` |
| Wrong `aud` | 403 | `access.test.ts`, `smoke.mjs` |
| Wrong `iss` | 403 | `access.test.ts` |
| The team's certs endpoint fails | 403 | `access.test.ts` |
| Valid, page path | The console page with its content policy | `gate.test.ts` |
| Valid, `/api/` without the console token | 401 | `gate.test.ts`, `smoke.mjs` |
| Valid, any method but GET | 405 | `gate.test.ts`, `smoke.mjs` |
| Valid, another site's `Origin` | 403 | `gate.test.ts` |
| Valid, `/api/agents` or `/api/agents/<id>` | Forwarded to the Agent DO | `gate.test.ts`, `host.test.ts` |
| `CONSOLE_TOKEN` secret missing or malformed | 500 | `gate.test.ts` |

## Webhooks

TaskFast posts each marketplace event to `POST /webhooks/taskfast`. That one path sits outside the Access check; its credential is the webhook signing secret.

| Request | Outcome | Test |
|---|---|---|
| Any method but POST | 405 | `worker.ts` |
| Body over 1 MiB | 413; no DO touched | `worker.ts` |
| `WEBHOOK_SECRET` not set | 401; no DO touched | `webhook.test.ts` |
| Missing signature or timestamp | 401; no DO touched | `webhook.test.ts` |
| Signature not lowercase hex HMAC-SHA256 of `<timestamp>.<body>` | 401; no DO touched | `webhook.test.ts` |
| Timestamp more than 5 minutes off | 401; no DO touched | `webhook.test.ts` |
| Signed, body not JSON | 400 | `host.test.ts` |
| Signed `test` event | 200; nothing stored | `host.test.ts` |
| Signed event without `event_id` (`saved_search_match`) | 200 and a log line; it cannot be deduplicated, so it is not stored | `host.test.ts` |
| Signed event | `deliver()` stores it durably, then 200; the DO stays alive until the turn is idle | `host.test.ts` |
| The same event again | 200; `deliver()` dedupes by `event_id`, no second turn | `host.test.ts` |
| Agent cannot open, or admission fails | 503, so the platform retries | `host.test.ts` |

The platform makes at most 3 attempts, then drops the event. The local host's `dead-letter.jsonl` has no counterpart here; the 15-minute alarm check is what catches work a dropped event announced.

Setup, once, with the local host for that folder stopped: run `taskfast webhook register --url https://<worker>/webhooks/taskfast --secret-file <file>` from the agent's folder, then `wrangler secret put WEBHOOK_SECRET` with that file's contents, then `taskfast webhook subscribe`. In Cloudflare Access, add a self-hosted application for the path `/webhooks/taskfast` with a Bypass policy. Otherwise Access answers TaskFast's posts with its login page and no event arrives.

## What the console shows

The page is the local console's page, unchanged. It needs the console token as a `#token=` link, so the owner opens `https://<worker>/#token=<CONSOLE_TOKEN>` once after signing in through Access. Its live stream (`/stream`) is not served, so the page polls every 3 s. Host facts (the wallet balance, stream state and dead letters) are absent, so those cards stay empty. Every console write control (pause, freeze, messages, orders, notes, limits) answers 405. The spending limits in `agent.json` are what cap money. Removing the wallet secrets makes every signing command a known refusal.

## Checks

From the repository root, `pnpm check` runs the Node tests under `cloudflare/src/`. `cloudflare/src/worker.ts` imports `cloudflare:workers` and is left out of the root typecheck.

From `cloudflare/`, after `pnpm install --ignore-workspace` and with the agent files in `cloudflare/agent/`:

```bash
node smoke.mjs ../agents/<staging agent>
```

It runs the Worker, the DO and the Container under `wrangler dev`, with a stand-in Access key server, then restarts workerd on the same storage. It refuses a production config. Stop that agent's local host first.

On the machine this was built on, local `wrangler dev` cannot start any Container, including Cloudflare's minimal example: Docker creates the proxy container and never the app container. The Access and console-token rows passed there in real workerd. The Container's server image passed under plain `docker run`: `node cli/proof.mjs` decrypts a throwaway keystore sent per call, and `node cli/staging-write.mjs` ran one signed staging `post` and its `task cancel`. A call from the DO to the Container has not run end to end.
