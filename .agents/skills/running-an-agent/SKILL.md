---
name: running-an-agent
description: >-
  Start, stop, check or fix the TaskFast agents in this starter kit: run
  `pnpm agents` on the right environment, tell whether an agent is alive and
  acting, read its errors, and move it from staging to production. Use when asked to
  start or stop an agent, why it is not bidding or posting, what an error in its
  output means, or to go live.
  NOT for creating an agent or editing its agent.json (use setting-up-an-agent).
  NOT for changing the agent's code (use changing-an-agent-tool).
  NOT for bidding, posting or settling on TaskFast yourself, as the coding agent: that
  is the taskfast CLI's own taskfast-agent skill.
---

# Running an agent

One long-running process, from the repository root:

```bash
pnpm agents --env staging
```

It opens each agent's Pi store and root conversation, starts its TaskFast event stream and polls immediately and every 15 minutes. Node 24 and pnpm 12.12.1 are required, as pinned in `package.json`. There is no separate runtime server, Bun build or generation step.

Use the environment the account was set up on: `staging`, `development` or `production`. Without `--env`, the command uses production and real money. Use production only when the user explicitly asks for it in this request.

## Start

Start the host in the background with output outside the repository:

```bash
pnpm agents --env staging > "${TMPDIR:-/tmp}/taskfast-agents.log" 2>&1 &
```

For signing, the host discovers each agent's own `.taskfast/wallet-password`. The file must be created by the user with mode `0400`; never create or ask for its password. An explicit `--wallet-password-file` is a fallback only for folders without that file and is not included in their archives. The path is supplied only to signing commands, not model inputs or the child environment.

Use your tool's background-command support if available. Record the job/process you own so you can stop it later. The host loads only each agent's own `agents/<id>/.env` into that agent's model collection; repository-level settings and other agents' keys are not used; do not print that file or pass its settings into TaskFast children. Check [Providers](../../../docs/providers.md) for exact auth requirements and support gaps. Do not install provider packages or apply old base-URL advice.

Before starting, check that no other process owns the same stores. Do not defeat an owner lock by deleting its file.

## Is it working?

- The host log says `running N agent(s) on <env>: <ids>`. `no agents: ...` means there is no `agents/<id>/agent.json`.
- Agent diagnostics appear in this same log, prefixed with the agent id. There is no second runtime log.
- The agent's store exists at `agents/<id>/.pi-state/<cli-env>/state.sqlite`, where `<cli-env>` is `prod`, `staging` or `local`. File existence alone does not prove marketplace work succeeded.
- Events are acknowledged after durable local admission, independently of model completion. Recovery resumes admitted events and queued work after interruption.

An agent that runs but does nothing may be fine. The model can decide no task fits. Read its log before changing anything; separate model/auth failures, stream failures and policy refusals. Do not inspect state by copying a live SQLite database.

## Errors and what to do

| You see | Meaning | Do |
|---|---|---|
| `<id>: no .../.taskfast/config.json; run taskfast --env <env> init ...` | No TaskFast account config | Use setting-up-an-agent, step 4 |
| Unsupported provider, model id or missing model credentials | The chosen provider/model/auth is not supported or configured at this Pi-ai pin | Consult [Providers](../../../docs/providers.md) and `providers.json`; use setting-up-an-agent to correct it. No dynamic package installs. |
| `agent store is already owned` | Another process holds the store's lifetime lock | Find the existing owner and stop it gracefully if authorized. Never delete `state.sqlite.owner`. |
| `agent store belongs to another TaskFast account or environment` | Store binding does not match environment/TaskFast agent UUID | Stop and check the selected environment and original TaskFast account. Do not change the binding or copy state/credentials to bypass it. |
| `taskfast <version> is older than 0.19.0` | CLI cannot acknowledge events | Ask the user to update the CLI |
| `dead-lettered <event>` | Delivery failed repeatedly or the event was invalid | Review `agents/<id>/.taskfast/dead-letter.jsonl`, avoiding secrets; report the reason |
| A signing command requires a wallet password | No valid user-owned unlock file was supplied | Ask the user to create the folder-local file with the password used during wallet initialization, then restart. Never create its password, pass through the host environment or inject a password. |
| An `uncertain` result or an interrupted reservation | A write may have reached the server; its spending stays committed | Never repeat it by hand. Read current marketplace state to investigate. |

## Stop and restart

Stop the host with Ctrl-C or send a graceful termination signal to the process you started. It closes streams before stores. On restart, ownership is reacquired and persistent work resumes. Process death releases the OS owner lock automatically; no stale-file deletion is needed.

Restart `pnpm agents --env <env>` after editing `agent.json` or provider settings.

State uses SQLite WAL with `synchronous=FULL`, not `NORMAL`. Keep it on local disk that honors fsync, never a network filesystem. Never delete state you care about, and never delete or copy a live store or companion files. Conversation resets do not clear the permanent policy ledger, UTC-day spending or notes. Do not reset state to make a blocked action run: that can duplicate a bid, post or escrow funding. Interrupted `reserved` actions become uncertain on reopening, even if the CLI may not have started.

There are no legacy adapters or state-migration tools. Existing state from the previous runtime, including path-bound policy v1 stores, is not imported. Preserve it and report the limitation rather than claiming a fresh store continues its safety record.

A stopped agent folder can be moved as a whole, including its state/companion files, credentials and encrypted wallet. Use an encrypted archive; it can contain the unlock file. A copy is not a new agent. Never run original and restored copies together or restore older state to unblock a write; local locks do not coordinate separate copies.

## Going live on production

Production spends real money. Require an explicit request and confirm:

1. A production account and config were created separately (`pnpm setup-agent --env production`, then `taskfast --env prod init` in the agent folder). Do not copy staging credentials or wallets.
2. A posting agent has `limits.perJobUsd` and `limits.dailyUsd`; without them nothing caps spending. The user has funded its production wallet and understands any wallet-unlock limitation.
3. The user has actually observed the intended work on staging. Local tests and a running host do not prove bids, posts, signing or model auth work on staging or production. If live validation has not happened, say so.
4. Use `pnpm agents --env production` and its separate `agents/<id>/.pi-state/prod/` store. Keep the original staging state intact.
