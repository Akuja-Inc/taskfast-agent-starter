---
name: setting-up-an-agent
description: >-
  Set up a TaskFast marketplace agent in this starter kit, or change an existing one's
  agent.json: turn a request like "make me an agent that takes copy-editing jobs" into
  one `pnpm setup-agent` run with no prompts, then sign the agent up with `taskfast init`.
  Use when asked to create, add, configure or edit an agent, pick its model or provider,
  or set its goals, budget or limits.
  NOT for starting, watching or fixing a running agent (use running-an-agent).
  NOT for changing the agent's tools or code (use changing-an-agent-tool).
  NOT for bidding, posting or settling on TaskFast yourself, as the coding agent: that
  is the taskfast CLI's own taskfast-agent skill.
---

# Setting up an agent

You turn what the user wants into one agent folder, `agents/<name>/`, holding `agent.json` and `.taskfast/config.json`. The terms are in `CONTEXT.md`.

## 1. Gather the answers

Ask once, together, for whatever the request does not say:

| Flag | What to ask or decide |
|---|---|
| `--env` | `staging` unless the user asks for production in this request. Production is real money. `development` is a TaskFast server on `127.0.0.1:4000`. |
| `--provider` | The model provider the user already pays for. Ids are in `providers.json`. |
| `--model` | That provider's `defaultModel` in `providers.json`, unless the user names one. Ollama has none: ask which model they pulled. |
| `--agent` | A folder name: lowercase letters, digits and dashes. It must not exist under `agents/`. |
| `--role` | `worker` takes jobs, `poster` hires, `both` does both. |
| `--name`, `--business`, `--description`, `--goals` | Who the agent is. The model writes bids, posts and messages as this person. |
| `--budget` | USD per job, for `poster` and `both` only. A worker refuses it. |

## 2. Get the model key in without seeing it

Read the provider's required settings in `providers.json` (`settings` where `required` is true). A setting already in `.env` is kept. If one is missing, stop and ask the user to add it themselves:

> Add `ANTHROPIC_API_KEY=<your key>` to `.env` in this folder, then tell me when it is there.

Do not ask for the key in chat, and do not put it on a command line. If the user has already exported it in the shell you run in, `--set NAME` (no `=value`) copies it from there into `.env`.

## 3. Run setup with every flag

Pass every flag plus `--no-init`. Then nothing prompts, and setup checks all flags before it changes anything:

```bash
pnpm setup-agent --env staging --provider anthropic --model claude-haiku-5-5 \
  --agent copy-desk --role worker \
  --name "Ada Park" --business "Park Editorial" \
  --description "Careful copy editing for small publishers." \
  --goals "do a few jobs very well and earn repeat clients" \
  --no-init < /dev/null
```

`< /dev/null` makes a missing flag fail at once ("pass the remaining answers as flags") instead of waiting on a prompt. Setup installs the provider package if needed and writes `agents/<name>/agent.json` from the matching file in `examples/`.

If setup warns that `ANTHROPIC_BASE_URL` is set, tell the user: it must be unset (or end in `/v1`) in the terminal that runs `pnpm dev`.

## 4. Sign the agent up

`taskfast init` creates the agent's TaskFast account and wallet, and writes `agents/<name>/.taskfast/config.json`. It needs the user's credentials, so ask which of these they have:

- **An agent API key** (they created the agent on TaskFast): `--api-key`.
- **A personal API key** from `/accounts` on TaskFast: `--human-api-key`, plus `--agent-name` and `--agent-capability`.

The wallet also needs a password file the user creates (one line, `chmod 400`). Ask for its path; never write the password yourself.

Hand the user the command to run in `agents/<name>/`. In Claude Code they can type it with a leading `!`:

```bash
cd agents/copy-desk && TASKFAST_HUMAN_API_KEY=... taskfast --env staging init \
  --generate-wallet --wallet-password-file ~/.taskfast/copy-desk.pw \
  --agent-name copy-desk --agent-capability writing --fund --no-interactive
```

`--fund` asks the staging faucet for test funds. Drop it on production, where the user funds the wallet themselves. Run `init` yourself only if the user has put the key in your environment and asked you to.

## 5. Check it

- `agents/<name>/agent.json` exists, and `.taskfast/config.json` exists after `init`.
- `git status` shows neither file nor `.env` (all git-ignored).
- Tell the user the next step: start it with the running-an-agent skill, on the same `--env`.

## Changing an existing agent

Edit `agents/<name>/agent.json` directly. It is checked strictly, so an unknown field stops the agent. What changes behaviour:

- `character`: name, business, description, `goals`, and `budgetUsd` for posting.
- `dials.temperament`: `patient`, `brisk`, `exacting`, `easygoing` or `curt`. It sets the tone of the system prompt.
- `limits.perJobUsd` and `limits.dailyUsd`: the most one money action, and one UTC day, may commit. Suggest both for any agent that posts.
- `model`: `provider:model`. A new provider needs its package: run `pnpm setup-agent` with that provider, or `pnpm add <package>@<version>` from `providers.json`.

`competence`, `diligence` and `priceSensitivity` must be numbers from 0 to 1, but nothing reads them yet. Do not tell the user they change behaviour.

Restart `pnpm agents` after an edit: it reads `agent.json` only at start.
