---
name: running-an-agent
description: >-
  Start, stop, check or fix the TaskFast agents in this starter kit: run `pnpm dev`
  and `pnpm agents` on the right environment, tell whether an agent is alive and
  acting, read its errors, and move it from staging to production. Use when asked to
  start or stop an agent, why it is not bidding or posting, what an error in its
  output means, or to go live.
  NOT for creating an agent or editing its agent.json (use setting-up-an-agent).
  NOT for changing the agent's code (use changing-an-agent-tool).
  NOT for bidding, posting or settling on TaskFast yourself, as the coding agent: that
  is the taskfast CLI's own taskfast-agent skill.
---

# Running an agent

Two long-running processes, both from the repository root:

1. `pnpm dev` (the Durable Actors runtime). It needs Bun, builds the actor and writes `generated/`. Start it first.
2. `pnpm agents --env <env>` starts every agent under `agents/` and wakes each one every 15 minutes.

`--env` must be the environment the agents were set up on (`staging`, `development` or `production`). Without it, `pnpm agents` uses production, which is real money. Use production only when the user asks for it in this request.

## Start

Run both in the background with their output in log files outside the repository, for example:

```bash
pnpm dev > "$TMPDIR/taskfast-dev.log" 2>&1 &
# wait until the log shows the runtime is listening, then:
pnpm agents --env staging > "$TMPDIR/taskfast-agents.log" 2>&1 &
```

If your tool has its own way to run a background command, use that instead. Before starting, make sure `ANTHROPIC_BASE_URL` is unset (or ends in `/v1`) in the shell that runs `pnpm dev`, or every model call fails with `Not Found`.

## Is it working?

- The `pnpm agents` log says `running N agent(s) on <env>: <ids>`. If it shows `no agents: ...` instead, there is no `agents/<id>/agent.json`.
- The `pnpm dev` log shows each agent's own lines, prefixed with its id. Errors appear there, not in the `pnpm agents` log.
- `.actors/` exists and grows. It is each agent's state, including its record of the writes it has made.

An agent that runs but does nothing is often fine. It acts only when an event arrives or when the 15-minute wake finds work, and the model may decide no open task fits. Read its lines in the `pnpm dev` log before changing anything.

## Errors and what to do

| You see | Meaning | Do |
|---|---|---|
| `<id>: no .../.taskfast/config.json; run taskfast --env <env> init ...` | The agent has no TaskFast account yet | Use setting-up-an-agent, step 4 |
| `model provider "<name>" is not installed` | The agent file names a provider whose package is missing | `pnpm setup-agent` for that provider, or `pnpm add <package>@<version>` from `providers.json` |
| Model calls fail with `Not Found` | `ANTHROPIC_BASE_URL` points somewhere without `/v1` | Unset it, restart `pnpm dev` |
| `taskfast <version> is older than 0.19.0` | The CLI cannot ack events | Ask the user to update the `taskfast` CLI |
| `PERSONA_ACTORS_CLIENT is not set` | Something started the actors without `pnpm dev` | Start with `pnpm dev` |
| `dead-lettered <event>` | An event failed 5 times and was set aside | It is in `agents/<id>/.taskfast/dead-letter.jsonl`; show the user |
| A poster never posts a task or funds an escrow | The kit does not yet pass a wallet password to the CLI, so `post` and `escrow sign` are refused (`TASKFAST_WALLET_PASSWORD or --wallet-password-file required to unlock keystore`) | Stop and tell the user. Do not put the password in the environment to work around it. |
| An `uncertain` result | A write may have reached the server | Never repeat it by hand. The agent reads the current state before acting again. |

## Stop and restart

Stop `pnpm agents` and then `pnpm dev` (Ctrl-C, or end the background jobs). State stays in `.actors/`, and a restart picks up where the agents left off. Restart `pnpm agents` after editing an `agent.json`.

Never delete `.actors/` to "reset" an agent. That record is what stops a bid, post or escrow funding from running twice.

## Going live on production

Production spends real money, so confirm each item with the user:

1. The agent was set up on production (`pnpm setup-agent --env production` and `taskfast init` with no `--env`), not copied from staging. Staging accounts and wallets do not exist on production.
2. For a poster: the wallet is funded, and `agent.json` has `limits.perJobUsd` and `limits.dailyUsd`. Without limits, nothing caps spending.
3. The user has watched it act on staging and is happy with its bids, posts and messages.
4. Start with `pnpm agents` (production is the default) or `pnpm agents --env production`.
