---
name: changing-an-agent-tool
description: >-
  Add, change or remove a tool the starter kit's agent can call (the TOOLS table in
  src/core/tools.ts), such as a new taskfast command, a new filter on a read, or a new
  write or money action, without breaking the once-only and money rules. Also use for
  other changes to the starter kit's code that change what the agent can do or how it
  behaves, such as policy checks, event delivery, or the console and terminal UI.
  Use when asked to let the agent do something new on TaskFast, change what a tool
  sends to the CLI, fix how a tool's command is built, or change kit code that alters
  agent behavior.
  NOT for setting up or configuring an agent (use setting-up-an-agent).
  NOT for starting or fixing a running agent (use running-an-agent).
  NOT for a behavior-preserving cleanup (use simplify).
  NOT for changing the agent's prompt or personality only (edit src/core/prompt.ts).
---

# Changing an agent tool

Each entry in `TOOLS` (`src/core/tools.ts`) maps a marketplace tool to a CLI command or a notes operation. `agent.ts` registers entries with Pi for every role; Pi owns model/tool tasks, while session-scoped `policy.ts` owns marketplace safety. Read `AGENTS.md` ("Rules the code depends on") first; this skill gives the order to apply them in. Steps 1 to 6 are the tools-table procedure. Changes to other kit code that alter what the agent can do land here too; the last section maps each surface to its owning rule.

## 1. Check the command exists

Run `taskfast <command> --help` with the CLI version the kit requires (0.19.0 or later). Note every option the tool will pass, and what the command prints on success. If the command is new or its output shape changed, re-capture a fixture in `test/fixtures/cli/` (its README says how) and parse it in `test/cli-captures.test.ts`.

## 2. Pick the kind

| Kind | Use when | Must also have |
|---|---|---|
| `read` | It changes nothing on the server. Safe to repeat. | Nothing else. |
| `write` | It changes something on the server. | `key` |
| `money` | It commits funds. | `key` and `amount` |
| `memory` | It changes only the agent's notes. | Its own branch in `marketplacePolicy.execute` in `policy.ts` |

Reads are safe to replay. Writes, money actions and notes operations are registered unsafe to replay in `agent.ts`. Keep sequential execution and root-conversation-only policy access; do not enable forks or child conversations.

If in doubt between `read` and `write`, it is a `write`. If it can move funds, it is `money`.

## 3. Write the entry

- `description`: one sentence the model reads to decide when to call it. Say what it does and what it costs.
- `schema`: built with `obj(...)`, so `additionalProperties` is false. List required fields.
- `args(input)`: check every value with the validators at the top of `tools.ts` (`uuid`, `text`, `word`, `money`, `limit`, `hours`, or a new one beside them). Pass options as `--name=value`, using `opt(...)` for optional ones. Pass ids as positionals after `"--"`. Never put a raw input value into the args array.
- `key(input)` (write and money): names the action, such as `bid:<task>` or `escrow:<bid>`. Two calls with the same key are the same action and run once. Choose what makes two attempts "the same": usually the target id, plus a digest of the text when one task can have many (`message_send`). Policy refuses a write without a key; still check the new entry explicitly.
- `amount` (money): `bidPrice`, `submissionFee`, `bondStake` or `stakeQuote`. The amount is always read from the server in `money.ts`, never taken from the model's input. A new source means a new `AmountSource` and a new branch in `priceOf`, reading the server. A command that takes its amount as an option (`taskfast stake --amount`) gets that option from `priceOf`'s `flags`, which policy inserts before `--` at dispatch, so the amount sent is the amount counted; the schema never has an amount field.

If the CLI can refuse the command before acting with an error code not in `REFUSED` (`cli.ts`), leave it out unless the CLI guarantees the server did nothing. An unknown code is treated as `uncertain`, which is the safe side.

## 4. Update the tests

In `src/core/tools.test.ts`, add the command it builds to the `prepare` cases, at least one refusal for a bad value, and its key for a write.

One test pins the whole table on purpose and will fail until you update it: "marks exactly the five tools that commit funds as money", the list of money tools. Adding to it means the agent can spend money in a new way. Confirm that with the user before you change the expected list.

In `test/cli-parity.ts`, add one call to `SAMPLES` that sets every field of the tool (a list of calls when fields exclude each other, as `review_list`'s do), and drop the command's `EXCLUDED` entry. `test/cli-parity.test.ts` then checks every flag and every `enum` value the tool passes against the CLI's captured `--help`. A field that feeds a flag with fixed values needs an `enum`; when the server's word differs from the CLI's (`accepted_pending_escrow` and `accepted-pending-escrow`), advertise the server's and translate in `args`, as `oneOf` does.

If the tool offers a fixed list of values the server publishes (an `enum`, such as `bid_list`'s `status`), add a case to `test/tools-contract.test.ts` that compares it with `test/fixtures/openapi.yaml`.

Never loosen a check to make a new tool fit.

## 5. Check

Use Node 24 and pnpm 12.12.1:

```bash
pnpm install --frozen-lockfile   # prepare builds dist/
pnpm typecheck
pnpm test
```

No Bun or generation step is needed. If policy dispatch changes, cover persistent-store restart as well as argument construction: reservation and spending must commit before the CLI, limits must be rechecked at dispatch, interrupted reservations must become uncertain, and only known refusals may retry. Keep the session-scoped action ledger and UTC-day spend records permanent and unbounded. Never delete or copy live state to test a reset; use fresh temporary stores. Local tests do not prove live staging or production behavior.

## 6. Tell TaskFast

TaskFast's downstream tooling pins this repository by commit, and its `tools-contract.test.ts` checks tool enum values against TaskFast's OpenAPI spec. In the PR description, list tools and enums you added or changed. Consumers must use the new `agent`, `policy` and `storage` lifecycle; `actors`, `self` and `turn` exports are removed without legacy adapters.

## Kit code beyond the tools table

`running-an-agent` routes every "change the agent's code" request here, and most land outside `tools.ts`. For each surface the owning rule lives in `AGENTS.md` under "Rules the code depends on", and `.agents/lessons/` may pin a trap for it. Read both before editing.

| Surface | Owning rule |
|---|---|
| `policy.ts` reservations, limits, ledger | Reserve before dispatch. Only a known refusal retries. The ledger and daily spend stay permanent and unbounded. |
| `agent.ts` registration, recovery, event retries | Pi owns model and tool tasks. Writes register unsafe to replay. Recovery never repeats an uncertain write. |
| `skills.ts` and the agent-folder skills | Skills are guidance, never permission. `skill_read` takes a name and a listed file, never a path. |
| `mcp.ts` tool approvals | The owner's fingerprint approves a tool. MCP tools never pass through marketplace policy. |
| `run.ts`, `listener.ts`, `pump.ts` | Console readiness is not agent readiness. ACK means durable admission. The host closes streams before stores. |
| `console-page.ts`, `console-*.ts`, `src/tui/` | The console reads through the running host. The TUI is a separate client of the same API. |

Whatever the surface: write the failing test first where the change allows, keep the change scoped to what the request needs, and run `pnpm check` before committing. Policy and storage changes also need real persistent-store restart and ownership checks, not only mocked model calls. A behavior-preserving cleanup is `simplify`, and the finished change reaches main through `ship-pr`.
