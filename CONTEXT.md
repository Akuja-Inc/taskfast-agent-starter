# Context

The language of this repository: what each word means here, and which words to avoid. [README.md](README.md#code) maps the modules; this file defines the terms they use. Why the repository exists is in [INTENT.md](INTENT.md).

## What the agent sits between

- **TaskFast server**: the marketplace. It owns tasks, bids, escrow and settlement. The agent never calls it directly.
- **`taskfast` CLI**: the only way the agent reaches the server. Each command runs as a child process with the agent's own config (`cli.ts`).
- **Durable Actors runtime** (`durable-actors`): runs each agent as an actor and keeps its state in `.actors/`. Started by `pnpm dev`.
- **Model provider**: any AI SDK provider. It chooses the agent's next tool call. It never runs a command or sets an amount itself.
- **The user's wallet**: set up by `taskfast init`, funded and signed for by the user.

## Language

### Who is who

**Agent**:
The user's marketplace agent: one folder `agents/<name>/` with an agent file and a TaskFast config, run as one Persona actor. On the server it is an `Agent` account.
_Avoid_: bot, persona (except for the actor class), user.

**Coding agent**:
A tool such as Claude Code, OpenAI Codex, pi or GitHub Copilot that edits this repository or runs its commands for a person. It reads `AGENTS.md`. It is never the marketplace agent.
_Avoid_: agent, on its own, when the coding agent is meant.

**User**:
The person who owns the agent, its TaskFast account, its wallet and its model key.

**Persona** (`Persona`):
The actor class in `actors.ts`. One instance per agent, keyed by the agent's folder name.

**Host**:
Whatever calls `init()` and `ping()` on a Persona. Here that is `src/run.ts`. TaskFast's own persona tooling is another host. Only a host can set counterparties.

**Honest**:
Acting as an ordinary marketplace user would: real bids, real work, real settlement. The only kind of agent this repository builds.

### The agent file

**Agent file** (`agent.json`, `AgentSpec`):
Who the agent is and how it behaves: `role`, `model`, `character`, `dials` and optional `limits`. Checked strictly by `spec.ts`; an unknown field is refused.
_Avoid_: config (that is the TaskFast config), profile.

**Role**:
`poster` (hires), `worker` (takes jobs) or `both`.

**Character**:
The person the model writes as: name, business, description, goals and, for posting, `budgetUsd` per job.

**Dials**:
`temperament` sets the manner phrase in the system prompt (`prompt.ts`). `competence`, `diligence` and `priceSensitivity` are checked to be from 0 to 1, but nothing in this repository or in TaskFast reads them yet. Do not tell a user they change behaviour.

**Limits** / **Spend**:
`perJobUsd` caps one money action and `dailyUsd` caps a UTC day. Spend is what the agent has committed today, counted with or without limits.

**Model id**:
`provider:model`, for example `anthropic:claude-haiku-5-5`. The provider part names an `@ai-sdk/<provider>` package (`providers.ts`).

### Where it runs

**Environment**:
The kit's names are `production`, `staging` and `development`. The `taskfast` CLI's names for them are `prod`, `staging` and `local` (`ENVIRONMENTS` in `run.ts`). Use the kit's names with people and in `--env` for `pnpm` commands; the CLI's names appear in code and in `taskfast --env`.

**Runtime** (`Runtime` type):
What an agent's commands run against: its environment, the absolute path of its TaskFast config and, optionally, its counterparties. Set once at `init()`.
_Avoid_: runtime, on its own, for this; "runtime" alone means the Durable Actors runtime.

**TaskFast config** (`.taskfast/config.json`):
Written by `taskfast init`. It holds the agent's TaskFast API key and wallet settings. Never printed or committed.

**Provider settings** (`.env`):
The model provider's keys and settings, written by `pnpm setup-agent` and passed to the actors by `pnpm dev`.

### How the agent acts

**Event**:
One marketplace event from `taskfast events stream`, with an `event_id` and an `event` name.

**Pump** / **Listener**:
The pump runs one event stream and acks each event once `deliver()` has stored it (`pump.ts`). The listener starts one pump per actor in each runtime worker (`listener.ts`); after a worker restarts, the next call to the actor starts it again. An event that keeps failing is written to `dead-letter.jsonl` next to the agent's TaskFast config, then acked.

**Inbox**:
Events delivered and not yet shown to a turn.

**Ping**:
A wake-up from the host, every 15 minutes from `pnpm agents`. The runtime has no timers, and new open tasks arrive as no event, so this is how an idle agent looks for work.

**Turn**:
One run of the model over the inbox, made of steps, until the model ends it. Its transcript is what the model sees of its own tool calls.

**Step**:
One committed call to the actor: the model chooses a tool, or one chosen tool runs.

**Pending** / **armed**:
The tool call the model chose and that has not finished. A write is armed in one step (status `executing`) and runs in the next; only the call that armed it may run it.

**Tool**:
One entry in the tool table (`tools.ts`), with a kind:
- **read**: safe to repeat.
- **write**: changes something on the server; runs at most once per action key.
- **money**: a write that commits funds; its amount comes from the server and counts against limits.
- **memory**: changes only the agent's notes.

**Action key**:
The name of a write, such as `bid:<task>` or `escrow:<bid>`. Two attempts with the same key are the same action.

**Ledger** (`actions`):
One record per action key, never evicted. It is what makes a write run at most once.

**Outcome**:
How a command ended: `ok`; `failed`, refused before it acted, so it may be tried again; or `uncertain`, which may have reached the server, so it is never repeated and counts as spent.

**Notes** (`memory` field):
Short notes the agent keeps between turns with the `remember` and `forget` tools.
_Avoid_: memory, on its own; it is also the name of a tool kind.

**Counterparty**:
The other side of a write: a task's poster, a bid's bidder or a task's worker (`party` on each tool). A host may give a list of allowed counterparties; without one, nothing is checked.

### Maintaining the kit

**Provider catalogue** (`providers.json`, `src/core/providers.ts`):
Generated by `scripts/gen-providers.mjs` from the providers' packages, npm and models.dev. Not edited by hand.

**Kit scan** (`test/kit.test.ts`):
Fails if any file names private TaskFast test tooling. It covers these documents too.

**Pin**:
The exact commit of this repository that TaskFast's persona tooling depends on.
