# AGENTS.md

Notes for a coding agent working in this repository. [README.md](README.md) is the user guide: setup, the agent file, models and the module map in [Code](README.md#code). Read it first. This file lists only what you must not break, and how to check your work.

You are here for one of two reasons:

- **Helping someone run their own agent:** setting it up, starting it, or changing its `agents/<name>/agent.json`.
- **Changing the agent itself:** the code in `src/core/`, `src/run.ts`, `src/setup.ts` or `scripts/`.

## Running an agent

- **Production is the default, and production is real money.** `pnpm setup-agent`, `pnpm agents` and the `taskfast` CLI all target production unless told otherwise. Pass `--env staging` (testnet, free test funds) or `--env development` (a TaskFast server on `127.0.0.1:4000`). Use production only when the user asks for it in that request.
- Every setup question has a flag (`pnpm setup-agent --help`), so run setup without prompts. Pass keys as `--set NAME` with the value already in the environment, not `--set NAME=value`, so they stay out of shell history and your transcript.
- `pnpm dev` (the actor runtime) and `pnpm agents` run until stopped. Start them in the background, `pnpm dev` first.
- Never print, commit or copy `.env` or `agents/*/.taskfast/config.json`. They hold the model key and the TaskFast API key. Both are git-ignored; keep it that way.
- Do not delete `.actors/` while an agent has state you care about. It holds each agent's record of the writes it has made, and that record is what stops a write running twice. Delete it and a bid, post or escrow funding can run again.
- An agent file is checked strictly (`src/core/spec.ts`), so add no extra fields. Start from a file in `examples/`. `limits` is optional, but suggest it for any agent that posts: without it, nothing caps spending.

## Changing the code

### Check your work

Node 24 and pnpm 10, as in CI (`.github/workflows/ci.yml`):

```bash
pnpm install --frozen-lockfile   # also builds dist/ (prepare)
pnpm typecheck
pnpm test
```

CI runs the same three on every PR. Keep `pnpm-lock.yaml` in step with `package.json`; `--frozen-lockfile` fails otherwise.

### Rules the code depends on

- **A write runs at most once.** Every `write` or `money` tool in `src/core/tools.ts` needs a `key` that names the action (`bid:<task>`, `escrow:<bid>`). The type leaves `key` optional and no test checks that a new tool has one, so check it yourself: a write with no key shares one ledger entry with every other keyless write. Keep the ledger (`actions` in `actors.ts`) unbounded; never evict entries.
- **Only a refusal is retried.** `cli.ts` sorts each result into `ok`, `failed` (refused before acting) or `uncertain` (may have reached the server). Never retry an `uncertain` write. Add a CLI error code to `REFUSED` only if the CLI guarantees that the server did nothing.
- **Code sets every amount of money, never the model.** A `money` tool names its `amount` source, which `money.ts` reads from the server (`amountOf`). The money rule runs `authorize` when the write is armed, `recheck` just before it runs and `account` afterwards. Count `uncertain` as spent.
- **Model values never become flags.** Pass tool inputs as `--name=value` options or as positionals after `--`, each one checked by a validator in `tools.ts`. Never splice raw input into the args.
- **Every write names its `party`** (`null` only for a post). The type enforces this; `counterparty.ts` relies on it.
- **`Persona` methods are public.** The runtime exposes every method on the class and requires each to be async, so internal steps stay module functions in `actors.ts`. Do not add `@Interleave`: `deliver()` relies on one call per actor at a time.
- **One CLI child per command.** `runCli` gives it the agent's own config, `--env` ahead of the subcommand, and an environment with only `PATH`, `HOME` and `TASKFAST_CONFIG`. Do not pass the host environment through.

### Generated and captured files

- `providers.json` and `src/core/providers.ts` are generated. Change `scripts/gen-providers.mjs` and run `node scripts/gen-providers.mjs` (it needs the network). The run refuses to drop a provider or setting unless you record it in `REMOVED` or `REMOVED_SETTINGS`. `test/setup.test.ts` checks the catalogue against the pins in `package.json`.
- `test/fixtures/cli/` holds real `taskfast` CLI output. Re-capture it when the CLI version changes, as its README says. Do not hand-edit it to make a test pass.
- `generated/`, `dist/` and `.actors/` are build and runtime output. Do not commit them.

### The kit scan

This kit runs honest agents only. `test/kit.test.ts` scans every file in the repository, this one included, for words that belong to private TaskFast test tooling, and fails on any match. Some patterns match inside longer words. Read the list in that test before you name things, and do not copy names, labels or strategies from the TaskFast repository. If an ordinary word trips the scan, choose another word; do not weaken the test.

### Downstream: the TaskFast repository

TaskFast's persona tooling pins this repository by commit and imports `taskfast-agent-starter/<module>`, which `exports` maps to `dist/src/core/<module>.js`. It also copies `src/core/` as source before `durable-actors generate`. Renaming or moving a module in `src/core/`, or changing an export it uses, breaks TaskFast at its next pin bump. On that PR, its `tools-contract.test.ts` also checks the tool table in `tools.ts` against TaskFast's OpenAPI spec, so a tool's enum values must match what the server publishes. Call out such changes in your PR description.

`durable-actors` is pre-1.0 and pinned exactly, and its build needs TypeScript 5.9. Bump it on its own, never as part of another change.
