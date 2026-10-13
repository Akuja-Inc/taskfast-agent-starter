# AGENTS.md

Notes for a coding agent working in this repository. Read [README.md](README.md) first for setup, agent files, models and the [module map](README.md#code). [INTENT.md](INTENT.md) says what to choose when a change is unclear; [CONTEXT.md](CONTEXT.md) defines the terms. This file lists what not to break and how to check your work.

You are here to help someone run or configure their own agent, or to change code in `src/core/`, `src/run.ts`, `src/setup.ts` or `scripts/`.

## Running an agent

- **Production is the default and real money.** Setup, `pnpm agents` and the CLI target production unless told otherwise. Use `--env staging` (free test funds) or `--env development` (server on `127.0.0.1:4000`). Use production only when the user explicitly asks for it in this request.
- Every setup question has a flag (`pnpm setup-agent --help`); run without prompts. Pass keys as `--set NAME` with the value already in the environment, never `--set NAME=value` in your commands or transcript.
- `pnpm agents --env staging` is the only long-running host needed. It opens stores, agents, streams and periodic polling in one process. Start it in the background when using tools. No separate runtime, Bun or generation command is needed.
- Never print, commit or copy `.env`, `.envrc` or `agents/*/.taskfast/config.json`. Each agent's private `agents/<id>/.env` supplies only its own model settings; do not load repository-level settings. TaskFast children retain their restricted environment and run from the owning folder. For signing, ask the user to create `agents/<id>/.taskfast/wallet-password` with mode 0400; the host discovers it automatically. The encrypted wallet belongs at `.taskfast/wallet.json` inside that same folder; initialize with `--keystore-path=.taskfast/wallet.json`. An explicit external host unlock override is not part of a portable archive;  never write its contents or forward passwords through the child environment.
- State lives in `agents/<agent>/.pi-state/<cli-env>/state.sqlite` (`prod`, `staging`, `local`). Keep it on local disk, never a network filesystem. Never delete state you care about; never delete or copy a live store or companion files. The ledger prevents duplicate bids, posts and escrow funding.
- One folder is one agent. Archive or move only a stopped agent, with all state/companion files; use an encrypted archive and never run original and restored copies together. Local locks do not coordinate copies. Policy binds to the server's agent UUID and environment, never a filesystem location. Earlier v1 ledgers fail closed without migration/reset: preserve them, never replace them with blank state under the same credentials.
- A separate `state.sqlite.owner` SQLite database holds a lifetime `BEGIN EXCLUSIVE` lock. A second owner is refused. Process death releases the OS lock; deleting the file is not lock recovery.
- SQLite uses WAL with `synchronous=FULL`, overriding the backend's `NORMAL` default. Power-loss durability still requires storage that honors fsync. Do not weaken synchronization or the owner lock.
- Agent files are strict (`spec.ts`): start from `examples/`, add no extra fields. Suggest both spending limits for posting; without limits nothing caps commitments.
- Provider support comes from pinned Pi-ai 1.1.0. Read [Providers](docs/providers.md) for auth choices and gaps. No arbitrary provider module loading, package installs during setup or automatic conversion of old settings/state.
- Do not claim live staging or production validation from local tests. Ask permission for live work and report exactly what was exercised.

## Changing code

### Check your work

Node 24 and pnpm 12.12.1, as pinned in `package.json` and used by CI:

```bash
pnpm install --frozen-lockfile   # prepare builds dist/
pnpm typecheck
pnpm test
```

`pnpm build` directly runs the TypeScript build. There is no actor build or generation step. Keep the lockfile in step with `package.json`. For policy or storage changes, include real persistent-store restart and ownership checks, not only mocked model calls. Keep live marketplace validation separate from local checks.

### Rules the code depends on

- **Pi owns conversation, model and tool tasks.** `openMarketplaceAgent(AgentOptions)` in `agent.ts` opens persistent storage and one root conversation. No coding tools, child conversations or forks are enabled. Marketplace tools execute sequentially and policy serializes reservation through dispatch.
- **Policy is permanent and session-scoped.** `Policy` in `policy.ts` owns `actions`, spend by UTC day and notes. Conversation reset or compaction must never erase it. Keep action and daily spending records unbounded; never evict entries.
- **Reserve before dispatch.** Every write or money tool needs a meaningful action key. Policy commits the reservation and spending atomically before invoking the CLI. Reopening converts interrupted `reserved` actions to `uncertain`. No dispatch permission survives a restart.
- **Only a refusal is retried.** CLI outcomes are `ok`, `failed` (known refusal before acting) and `uncertain`. Only a known failure releases spending and permits another attempt. Success and uncertain actions never repeat. Register writes as unsafe to replay in Pi. Add an error code to `REFUSED` only if the CLI guarantees the server did nothing.
- **Code sets every amount, never the model.** A money tool declares an `amount` source read from the server by `amountOf` in `money.ts`. Policy checks limits at reservation and immediately before dispatch, including UTC-day rollover. Interrupted or uncertain reservations remain spent, even if dispatch might not have started.
- **Model values never become flags.** Validate tool inputs in `tools.ts`; pass them as `--name=value` options or positionals after `--`. Never splice raw input into arguments.
- **Every write names its `party`** (`null` only for a post). Counterparty checks happen before reservation; a refused check must run no write.
- **ACK means durable admission, not model completion.** `deliver()` validates and stores the event before resolving. Preserve event-id deduplication and recovery of admitted work. The host closes streams before stores so it cannot acknowledge after ownership closes.
- **One CLI child per command.** `runCli` uses the agent's config, `--env` before the subcommand and only `PATH`, `HOME`, `TASKFAST_CONFIG` in the child environment. Never pass through the host environment.

### Generated and captured files

- `providers.json` and `src/core/providers.ts` are generated. Change `scripts/gen-providers.mjs` and run `node scripts/gen-providers.mjs` against the installed exact Pi-ai pin (offline). Record intended provider or setting removals in `REMOVED` or `REMOVED_SETTINGS`. Do not hand-edit generated outputs.
- `test/fixtures/cli/` holds real CLI output. Re-capture when the CLI contract changes, as its README says. Never edit captures to make a test pass.
- `dist/` and every agent's `.pi-state/` are build and runtime output. Do not commit them or credentials.

### The kit scan

This kit runs honest agents only. `test/kit.test.ts` scans repository files, including these documents, for names from private TaskFast test tooling. Some patterns match inside longer words. Read its list before naming things. Do not copy upstream names, labels or strategies. Choose another name if a match occurs; never weaken the scan.

### Downstream: the TaskFast repository

TaskFast's downstream tooling pins this repository by commit and imports `taskfast-agent-starter/<module>`, mapped to `dist/src/core/<module>.js` and declarations. The new exports are `agent`, `policy` and `storage`; `actors`, `self` and `turn` are removed. Downstream consumers MUST update imports and adopt `openMarketplaceAgent` with persistent local storage and explicit stream/shutdown ownership before bumping the pin. No legacy adapters or state-migration tooling are supplied; do not imply old state is imported or safely disposable.

Call out this breaking package/lifecycle change in the PR description. Tool enums must still match TaskFast's OpenAPI spec and its downstream `tools-contract.test.ts`.

The runtime is Pi Durable; `durable-actors` and its Bun build are no longer used, so its old pinning and bump rules no longer apply. The Pi packages are experimental and pinned exactly to 1.1.0. Do not float versions or casually combine a runtime upgrade with unrelated changes; verify persistence, replay safety and provider support at any new pin.
