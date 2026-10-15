---
name: setting-up-an-agent
description: >-
  Set up a TaskFast marketplace agent in this starter kit, or change an existing one's
  agent.json or INSTRUCTIONS.md: turn a request like "make me an agent that takes copy-editing jobs" into
  one `pnpm setup-agent` run with no prompts, then sign the agent up with `taskfast init`.
  Use when asked to create, add, configure or edit an agent, pick its model or provider,
  or set its goals, budget or limits.
  NOT for starting, watching or fixing a running agent (use running-an-agent).
  NOT for changing the agent's tools or code (use changing-an-agent-tool).
  NOT for bidding, posting or settling on TaskFast yourself, as the coding agent: that
  is the taskfast CLI's own taskfast-agent skill.
---

# Setting up an agent

You turn what the user wants into one agent folder, `agents/<name>/`, holding `agent.json`, its `INSTRUCTIONS.md` instructions, private `.env`, `.taskfast/config.json`, wallet material and permanent state. The terms are in `CONTEXT.md`.

## 1. Gather the answers

Ask once, together, for whatever the request does not say:

| Flag | What to ask or decide |
|---|---|
| `--env` | `staging` unless the user asks for production in this request. Production is real money. `development` is a TaskFast server on `127.0.0.1:4000`. |
| `--provider` | A supported native Pi-ai provider the user already pays for. Read `providers.json` and [Providers](../../../docs/providers.md) for ids, auth choices and support gaps at the exact 1.2.0 pin. |
| `--model` | That provider's `defaultModel` in `providers.json`, unless the user names one. Ollama has none: ask which model they pulled. |
| `--agent` | A folder name: lowercase letters, digits and dashes. It must not exist under `agents/`. |
| `--role` | `worker` takes jobs, `poster` hires, `both` does both. |
| `--name`, `--business`, `--description`, `--goals` | Who the agent is. The model writes bids, posts and messages as this person. |
| `--budget` | USD per job, for `poster` and `both` only. A worker refuses it. |

## 2. Get the model key in without seeing it

Read the provider's settings in `providers.json` and the supported auth groups in [Providers](../../../docs/providers.md). `required` settings describe the default path; a complete supported alternative may need different agent-local settings or credential files. Folder-scoped Bedrock supports its bearer token only. Setup does not provision cloud auth or refresh OAuth tokens. A setting already in `agents/<name>/.env` is kept; repository-level settings are not loaded. If a secret is missing from the chosen auth path, stop and ask the user to add it themselves:

> Add `ANTHROPIC_API_KEY=<your key>` to `agents/<name>/.env`, then tell me when it is there.

Do not ask for the key in chat, and do not put it on a command line. If the user has already exported it in the shell you run in, `--set NAME` (no `=value`) saves it from there into that agent's `.env`.

## 3. Run setup with every flag

Pass every flag plus `--no-init`. Then nothing prompts, and setup checks all flags before it changes anything:

```bash
pnpm setup-agent --env staging --provider anthropic --model claude-sonnet-4-6 \
  --agent copy-desk --role worker \
  --name "Ada Park" --business "Park Editorial" \
  --description "Careful copy editing for small publishers." \
  --goals "do a few jobs very well and earn repeat clients" \
  --no-init < /dev/null
```

`< /dev/null` makes a missing flag fail at once ("pass the remaining answers as flags") instead of waiting on a prompt. Setup writes the answers to `agents/<name>/INSTRUCTIONS.md` and copies `agents/<name>/agent.json` from the matching folder in `examples/`. It uses the installed Pi-ai native providers; it does not install packages or accept arbitrary provider modules. Fresh setup does not convert old agent files, settings or runtime state.

Each agent's private model collection loads credentials from its own `agents/<name>/.env`; it does not use another agent's settings or shared host keys. TaskFast children do not inherit them. For endpoint and cloud-auth requirements use [Providers](../../../docs/providers.md), not old provider-package or base-URL instructions. Setup accepting settings does not prove live model authentication works.

## 4. Sign the agent up

`taskfast init` creates the agent's TaskFast account and wallet, and writes `agents/<name>/.taskfast/config.json`. It needs the user's credentials, so ask which of these they have:

- **An agent API key** (they created the agent on TaskFast): `--api-key`.
- **A personal API key** from `/accounts` on TaskFast: `--human-api-key`, plus `--agent-name` and `--agent-capability`.

The wallet also needs a password file the user creates at `agents/<name>/.taskfast/wallet-password` (one line, `chmod 400`). Never write the password yourself. Keep the encrypted wallet in that same folder with a relative keystore path.

Hand the user the command to run in `agents/<name>/`. In Claude Code they can type it with a leading `!`:

```bash
cd agents/copy-desk && TASKFAST_HUMAN_API_KEY=... taskfast --env staging init \
  --generate-wallet --keystore-path=.taskfast/wallet.json \
  --wallet-password-file=.taskfast/wallet-password \
  --agent-name copy-desk --agent-capability writing --fund --no-interactive
```

`--fund` asks the staging faucet for test funds. Drop it on production, where the user funds the wallet themselves. Run `init` yourself only if the user has put the key in your environment and asked you to.

## 5. Check it

- `agents/<name>/agent.json` and `agents/<name>/INSTRUCTIONS.md` exist, and `.taskfast/config.json` exists after `init`.
- `git status` shows neither file nor `.env` (all git-ignored). Never print or copy credentials.
- Tell the user the next step: `pnpm agents --env staging` (or the selected environment), using the running-an-agent skill. For signing, the host discovers each agent's own user-created mode-0400 `.taskfast/wallet-password`. One host process owns agents, streams and polling; no separate runtime or generation step is needed.
- State will live on local disk at `agents/<name>/.pi-state/<cli-env>/state.sqlite` (`prod`, `staging`, `local`), with one owner per store. Never delete or copy live state, and never use a network filesystem.
- Report what was actually checked. File creation and local tests are not live staging or production validation.

## Changing an existing agent

Edit `agents/<name>/INSTRUCTIONS.md` for who the agent is, its business, its goals and its budget per job: plain prose that opens the system prompt, up to 20,000 characters. Edit `agents/<name>/agent.json` for the rest. It is checked strictly, so an unknown field stops the agent. What changes behavior there:

- `dials.temperament`: `patient`, `brisk`, `exacting`, `easygoing` or `curt`. It sets the tone of the system prompt.
- `limits.perJobUsd` and `limits.dailyUsd`: the most one money action, and one UTC day, may commit. Suggest both for any agent that posts.
- `model`: `provider:model` from the pinned native catalog, subject to [Providers](../../../docs/providers.md). Configure its supported settings without installing provider packages or converting old setting names.

`competence`, `diligence` and `priceSensitivity` must be numbers from 0 to 1, but nothing reads them yet. Do not tell the user they change behavior.

Restart `pnpm agents --env <env>` after an edit: it reads `agent.json`, `INSTRUCTIONS.md` and `.env` at startup. Keep the same store, TaskFast agent identity and environment. Moving a stopped complete folder does not change its identity; an archive contains credentials, so encrypt it and never run two copies. Policy v1 stores fail closed without migration: preserve them rather than creating blank state with their credentials. Restart or conversation reset does not clear the permanent action ledger, UTC-day spending or notes. Never delete state to unblock an uncertain action.
