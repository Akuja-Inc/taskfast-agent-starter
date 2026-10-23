# The Durable Object host

This is how one owner's agent runs on their own Cloudflare account (#144). It covers PR3: the Durable Object (DO) host, the Access check and the CLI Container for reads. Marketplace writes, the wallet, webhooks and R2 come in later PRs. Nothing here has run on a deployed Cloudflare account yet.

## Parts

- **The Worker** (`cloudflare/src/worker.ts`) receives every request. `gate()` in `cloudflare/src/gate.ts` checks the Cloudflare Access token, then the console token, before any DO is touched.
- **The Agent DO** owns the agent's store. `agentHost()` in `cloudflare/src/host.ts` opens it with `openMarketplaceAgent`, on the DO's SQLite storage through Pi's `openDurableObjectSqliteStorage`. A DO is single-instance, so it takes the place of the local owner lock.
- **The CLI Container** (`cloudflare/cli/`) runs the pinned `taskfast` release behind one route, `POST /run`. Each call gets a fresh folder holding only the agent's TaskFast config, which the Container deletes afterwards. Only the Agent DO's binding reaches it.
- **The marketplace path** is `containerCommand()` in `cloudflare/src/container.ts`. It sends only the read tools' commands (`READ_COMMANDS`) and refuses every other command before anything leaves the DO. It maps the CLI's stdout with the same `cliOutcome` as the local host, so `REFUSED` keeps its meaning.

Secrets, set with `wrangler secret put`: `CONSOLE_TOKEN` (64 hex characters, the console page's bearer token), `TASKFAST_CONFIG` (the text of the agent's `.taskfast/config.json`) and `MODEL_SETTINGS` (a JSON object of provider settings, like the folder's `.env`). Vars in `wrangler.jsonc`: `AGENT_ID`, `CLI_ENV` (`prod`, `staging` or `local`), `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. The owner's `agent.json` and `INSTRUCTIONS.md` go in the git-ignored `cloudflare/agent/` folder and are bundled at deploy.

A provider setting that names a file, such as a Google Vertex credentials file, does not work from a secret. Use a provider whose key is a plain setting.

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
| Open | The model calls a write | Policy reserves, the command is refused before it leaves the DO, policy releases it as `failed` | `host.test.ts` "runs one work check" |
| Open | A read reaches the Container and the CLI refuses it | `failed`, as on the local host | `container.test.ts` "keeps a captured refusal" |
| Open | The Container is unreachable, answers non-2xx, or its reply is unreadable | `uncertain`; for a read the tool fails and the turn continues | `container.test.ts` "is uncertain when" |
| Open | Session fails | Stopped with the reason; the next request reopens | `host.ts` (`closed` handler) |
| Evicted between reservation and dispatch | Next instance opens | `policy.initialize` turns `reserved` into `uncertain`, counted as spent | core policy tests; the DO-specific run waits for writes in PR4 |
| Evicted mid-turn | Next instance opens | The conversation resumes from Pi's store; the alarm runs the next check | `spikes/cloudflare/restart-proof.mjs` |
| Open | Alarm cut off by a deploy or its 15-minute wall-time limit | The alarm set a retry in 60 s before the turn started, so the next check still runs | not run; needs a deploy |
| Restarted | Owner reads | The same ledger and transcript | `smoke.mjs` restart rows |

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

The webhook route (PR5) must sit outside the Access check and verify its own HMAC.

## What the console shows

The page is the local console's page, unchanged. It needs the console token as a `#token=` link, so the owner opens `https://<worker>/#token=<CONSOLE_TOKEN>` once after signing in through Access. Its live stream (`/stream`) is not served yet, so the page polls every 3 s. Host facts (the wallet balance, stream state and dead letters) are absent, so those cards stay empty. Every write control answers 405 until writes land.

## Checks

From the repository root, `pnpm check` runs the Node tests under `cloudflare/src/`. `cloudflare/src/worker.ts` imports `cloudflare:workers` and is left out of the root typecheck.

From `cloudflare/`, after `pnpm install --ignore-workspace` and with the agent files in `cloudflare/agent/`:

```bash
node smoke.mjs ../agents/<staging agent>
```

It runs the Worker, the DO and the Container under `wrangler dev`, with a stand-in Access key server, then restarts workerd on the same storage. It refuses a production config. Stop that agent's local host first.

On the machine this was built on, local `wrangler dev` cannot start any Container, including Cloudflare's minimal example: Docker creates the proxy container and never the app container. The Access and console-token rows passed there in real workerd. The Container image passed on its own (`POST /run` answered `taskfast 0.21.0`). The read through the Container from the DO has not run end to end.
