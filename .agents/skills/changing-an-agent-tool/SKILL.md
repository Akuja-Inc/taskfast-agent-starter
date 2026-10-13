---
name: changing-an-agent-tool
description: >-
  Add, change or remove a tool the starter kit's agent can call (the TOOLS table in
  src/core/tools.ts), such as a new taskfast command, a new filter on a read, or a new
  write or money action, without breaking the once-only and money rules. Use when asked
  to let the agent do something new on TaskFast, change what a tool sends to the CLI,
  or fix how a tool's command is built.
  NOT for setting up or configuring an agent (use setting-up-an-agent).
  NOT for starting or fixing a running agent (use running-an-agent).
  NOT for changing the agent's prompt or personality only (edit src/core/prompt.ts).
---

# Changing an agent tool

Each entry in `TOOLS` (`src/core/tools.ts`) maps a marketplace tool to a CLI command or a notes operation. `agent.ts` registers entries with Pi for every role; Pi owns model/tool tasks, while session-scoped `policy.ts` owns marketplace safety. Read `AGENTS.md` ("Rules the code depends on") first; this skill gives the order to apply them in.

## 1. Check the command exists

Run `taskfast <command> --help` with the CLI version the kit requires (0.19.0 or later). Note every option the tool will pass, and what the command prints on success. If the command is new or its output shape changed, re-capture a fixture in `test/fixtures/cli/` (its README says how) and parse it in `test/cli-captures.test.ts`.

## 2. Pick the kind

| Kind | Use when | Must also have |
|---|---|---|
| `read` | It changes nothing on the server. Safe to repeat. | Nothing else. |
| `write` | It changes something on the server. | `key` and `party` |
| `money` | It commits funds. | `key`, `party` and `amount` |
| `memory` | It changes only the agent's notes. | Its own branch in `marketplacePolicy.execute` in `policy.ts` |

Reads are safe to replay. Writes, money actions and notes operations are registered unsafe to replay in `agent.ts`. Keep sequential execution and root-conversation-only policy access; do not enable forks or child conversations.

If in doubt between `read` and `write`, it is a `write`. If it can move funds, it is `money`.

## 3. Write the entry

- `description`: one sentence the model reads to decide when to call it. Say what it does and what it costs.
- `schema`: built with `obj(...)`, so `additionalProperties` is false. List required fields.
- `args(input)`: check every value with the validators at the top of `tools.ts` (`uuid`, `text`, `word`, `money`, `limit`, `hours`, or a new one beside them). Pass options as `--name=value`, using `opt(...)` for optional ones. Pass ids as positionals after `"--"`. Never put a raw input value into the args array.
- `key(input)` (write and money): names the action, such as `bid:<task>` or `escrow:<bid>`. Two calls with the same key are the same action and run once. Choose what makes two attempts "the same": usually the target id, plus a digest of the text when one task can have many (`message_send`). Policy refuses a write without a key; still check the new entry explicitly.
- `party` (write and money): who is on the other side: `poster`, `bidder`, `worker`, `other`, or `null` for a post. A `bidder` tool must require both `task_id` and `bid_id`, because the bidder is found among the task's bids.
- `amount` (money): `bidPrice` or `submissionFee`. The amount is always read from the server in `money.ts`, never taken from the model's input. A new source means a new `AmountSource` and a new branch in `amountOf`, reading the server.

If the CLI can refuse the command before acting with an error code not in `REFUSED` (`cli.ts`), leave it out unless the CLI guarantees the server did nothing. An unknown code is treated as `uncertain`, which is the safe side.

## 4. Update the tests

In `src/core/tools.test.ts`, add the command it builds to the `prepare` cases, at least one refusal for a bad value, and its key for a write.

Some tests pin the whole table on purpose and will fail until you update them:

- "marks exactly the two tools that commit funds as money": the list of money tools. Adding to it means the agent can spend money in a new way. Confirm that with the user before you change the expected list.
- "names the other side of every write": the `party` of every write. Add the new tool's.

Never loosen a check to make a new tool fit.

## 5. Check

Use Node 24 and pnpm 12.12.1:

```bash
pnpm install --frozen-lockfile   # prepare builds dist/
pnpm typecheck
pnpm test
```

No Bun or generation step is needed. If policy dispatch changes, cover persistent-store restart as well as argument construction: reservation and spending must commit before the CLI, limits must be rechecked at dispatch, interrupted reservations must become uncertain, and only known refusals may retry. Keep the session-scoped action ledger and UTC-day spend records permanent and unbounded. Never delete or copy live state to test a reset; use fresh temporary stores. Local tests do not prove live staging or production behaviour.

## 6. Tell TaskFast

TaskFast's downstream tooling pins this repository by commit, and its `tools-contract.test.ts` checks tool enum values against TaskFast's OpenAPI spec. In the PR description, list tools and enums you added or changed. Consumers must use the new `agent`, `policy` and `storage` lifecycle; `actors`, `self` and `turn` exports are removed without legacy adapters.
