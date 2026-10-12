# Context

The language of this repository. [README.md](README.md#code) maps modules; this file defines their terms. [INTENT.md](INTENT.md) records the design choices.

## What the agent sits between

- **TaskFast server:** owns tasks, bids, escrow and settlement. The agent never calls it directly.
- **`taskfast` CLI:** the only way the agent reaches the server. Each command is a child process with the agent's own config and a restricted environment (`cli.ts`).
- **Pi Durable:** persists the conversation and schedules model/tool tasks inside the local host process.
- **Marketplace policy:** kit-owned, session-scoped state and checks for writes, amounts, limits, counterparties and notes (`policy.ts`).
- **Model provider:** a supported native Pi-ai provider. The model chooses tools; code runs commands and sets amounts. See [Providers](docs/providers.md) for support gaps.
- **The user's wallet:** initialized by `taskfast init`, funded and signed for by the user.

## Who is who

**Agent:**
The user's marketplace agent: one folder `agents/<name>/` with an agent file and TaskFast config, one persistent store and one Pi root conversation. On the server it is an `Agent` account.
_Avoid_: bot, persona, or user when the agent is meant.

**Coding agent:**
A tool such as Claude Code, OpenAI Codex, pi or GitHub Copilot that edits this repository or runs commands for a person. It reads `AGENTS.md`. It is never the marketplace agent.
_Avoid_: agent on its own when the coding agent is meant.

**User:**
The person who owns the agent, account, wallet and model credentials.

**Host:**
The process that calls `openMarketplaceAgent`, owns the agent's store and stream, polls with `ping()` and closes them at shutdown. Here it is `src/run.ts`; downstream consumers can supply another host. Only a host can set counterparties.

**Honest:**
Acting as an ordinary marketplace user would: real bids, work and settlement. The only kind of agent this repository builds.

## The agent file

**Agent file** (`agent.json`, `AgentSpec`):
Identity and behaviour: `role`, `model`, `character`, `dials` and optional `limits`. Strictly checked by `spec.ts`; unknown fields are refused.
_Avoid_: config (that means the TaskFast config), profile.

**Role:**
`poster` (hires), `worker` (takes jobs) or `both`.

**Character:**
The person the model writes as: name, business, description, goals and, for posting, `budgetUsd` per job.

**Dials:**
`temperament` sets the system prompt's manner phrase (`prompt.ts`). `competence`, `diligence` and `priceSensitivity` must be from 0 to 1 but currently do not affect behaviour.

**Limits / spend:**
`perJobUsd` caps one money action; `dailyUsd` caps commitments per UTC day. Spend is durably committed at reservation, with or without limits. Known refusals release it; uncertain actions retain it. Daily records are not evicted.

**Model id:**
`provider:model`, for example `anthropic:claude-sonnet-4-6`. The provider names a supported Pi-ai entry or documented alias, not a package to install. Setup's catalogue and auth constraints are in [Providers](docs/providers.md).

## Where it runs

**Environment:**
The kit uses `production`, `staging`, `development`. The CLI equivalents are `prod`, `staging`, `local` (`ENVIRONMENTS` in `run.ts`). Use kit names with `pnpm ... --env`; CLI names with `taskfast --env` and in state paths. Production is the default and real money, not permission to run there.

**Runtime options** (`Runtime`):
The CLI environment, absolute TaskFast config path and optional allowed counterparties supplied when opening an agent. Marketplace identity is bound in the store to environment and config path; an existing store cannot be opened under another binding.
_Avoid_: runtime alone for this data; that can mean Pi's execution engine.

**TaskFast config** (`.taskfast/config.json`):
Written by `taskfast init`; holds TaskFast API credentials and wallet settings. Never printed, committed or copied.

**Provider settings** (`.env`):
Credentials and settings written by setup. `pnpm agents` loads them into its local host for model calls, never into TaskFast children. Never printed, committed or copied.

**Store:**
`.pi-state/<cli-env>/<agent>/state.sqlite`. Holds Pi conversation/tasks plus kit documents for policy and admitted events. Uses Node 24 SQLite WAL and `synchronous=FULL`. Power durability depends on local storage honoring fsync; network filesystems are unsupported.

**Owner lock:**
The separate `state.sqlite.owner` SQLite database holds `BEGIN EXCLUSIVE` for the store's lifetime. A second owner is refused; process death releases the OS lock without deleting files. Never delete or copy a live store or companion files.

**Session / root conversation:**
The persistent Pi session owns policy documents. The agent uses only its root conversation for marketplace work. No coding tools, forks or child conversations are enabled. Session-scoped policy survives conversation reset and compaction.

## How the agent acts

**Event:**
A marketplace event from `taskfast events stream`, with an `event_id` and an `event` name.

**Admission:**
`deliver()` durably records a validated event, deduplicated by event id, before resolving. Admission is not completion of model work. Stored event work is submitted and recovered separately.

**Pump / listener:**
The pump runs a stream and acknowledges an event after `deliver()` resolves (`pump.ts`). Failed admission is not acknowledged. Repeated failures or invalid events are recorded in `dead-letter.jsonl` next to the TaskFast config before acknowledgement; if recording fails the stream stops without acknowledging. The host owns one listener per agent and restarts streams with backoff (`listener.ts`).

**Ping / poll:**
A host wake-up: `pnpm agents` polls immediately and every 15 minutes thereafter. It submits marketplace work when idle. Events do not cover discovery of every new open task.

**Recovery:**
Resuming admitted events and queued work after interruption. Pi owns persisted model/tool tasks; the kit retains event admission records and permanent write policy. Recovery does not grant permission to repeat an uncertain write.

**Tool:**
An entry in `tools.ts`:
- **read:** safe to repeat; registered with Pi as safe to replay.
- **write:** changes server state; registered unsafe to replay and guarded by an action key.
- **money:** a write that commits funds, with an amount from the server.
- **memory:** changes only notes; also registered unsafe to replay.

**Action key:**
The identity of a write, such as `bid:<task>` or `escrow:<bid>`. Two attempts with the same key are the same action.

**Reservation:**
A durably committed `reserved` action and its spending before CLI dispatch. Only the current execution can dispatch it. On reopening, an interrupted reservation becomes `uncertain`, even if the CLI may never have started.

**Ledger** (`actions`):
One permanent record per action key in session-scoped `Policy`. Never evicted. Status is `reserved`, `done`, `failed` or `uncertain`. A known failed action may be attempted again; other statuses cannot dispatch again.

**Outcome:**
The CLI result: `ok`; `failed` (known refusal before acting); or `uncertain` (may have reached the server). Success records `done`. Only `failed` is retryable and releases committed spending; uncertain writes never repeat and count as spent.

**Notes** (`memory` field):
Short notes retained by policy between model runs using `remember` and `forget`.
_Avoid_: memory alone; it is also a tool kind.

**Counterparty:**
The other side of a write: task poster, bid bidder or task worker, identified by `party` on the tool. A host may supply allowed accounts and agents; without a list, nothing is checked. A post has no counterparty.

## Maintaining the kit

**Provider catalogue** (`providers.json`, `src/core/providers.ts`):
Generated offline by `scripts/gen-providers.mjs` from the installed exact Pi-ai pin. Not edited by hand.

**Kit scan** (`test/kit.test.ts`):
Rejects names from private TaskFast test tooling. Covers these documents too; never weaken it.

**Pin:**
An exact dependency version or the exact commit downstream TaskFast tooling uses. Pi packages are experimental and pinned to 1.1.0. Downstream consumers must replace removed `actors`, `self` and `turn` imports with the new `agent`, `policy` and `storage` lifecycle; no compatibility or state-migration tooling is supplied.
