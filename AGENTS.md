# AGENTS.md

Notes for a coding agent working in this repository. Read [README.md](README.md) first for setup, agent files, models and the [module map](README.md#code). [INTENT.md](INTENT.md) says what to choose when a change is unclear; [CONTEXT.md](CONTEXT.md) defines the terms. This file lists what not to break and how to check your work.

You are here to help someone run or configure their own agent, or to change code in `src/core/`, `src/run.ts`, `src/console.ts`, `src/console-page.ts`, `src/setup.ts` or `scripts/`.

## Running an agent

- **Production is the default and real money.** Setup, `pnpm agents` and the CLI target production unless told otherwise. Use `--env staging` (free test funds) or `--env development` (server on `127.0.0.1:4000`). Use production only when the user explicitly asks for it in this request.
- Every setup question has a flag (`pnpm setup-agent --help`); run without prompts. Pass keys as `--set NAME` with the value already in the environment, never `--set NAME=value` in your commands or transcript.
- `--env` selects folders by `.taskfast/config.json`'s explicit `environment`, not by folder names or state directories. Unpinned or mismatched folders are skipped before agent resources open and are absent from the console dropdown. Do not reinitialize credentials or reset ledgers to make them match; verify the account's environment before setting an absent association.
- `pnpm agents --env staging` is the only long-running host needed. It opens stores, agents, streams and periodic polling in one process. Start it in the background when using tools. No separate runtime, Bun or generation command is needed.
- Never print, commit or copy `.env`, `.envrc`, `agents/*/.mcp.env` or `agents/*/.taskfast/config.json`. Each agent's private `agents/<id>/.env` supplies only its own model settings; do not load repository-level settings. TaskFast children retain their restricted environment and run from the owning folder. For signing, ask the user to create `agents/<id>/.taskfast/wallet-password` with mode 0400, or to run setup themselves, which writes it. Never answer setup's wallet password question or pass `--wallet-password-env` yourself. The host discovers the file automatically. The encrypted wallet belongs at `.taskfast/wallet.json` inside that same folder; initialize with `--keystore-path=.taskfast/wallet.json`. An explicit external host unlock override is not part of a portable archive;  never write its contents or forward passwords through the child environment.
- State lives in `agents/<agent>/.pi-state/<cli-env>/state.sqlite` (`prod`, `staging`, `local`). Keep it on local disk, never a network filesystem. Never delete state you care about; never delete or copy a live store or companion files. The ledger prevents duplicate bids, posts and escrow funding.
- One folder is one agent. Archive or move only a stopped agent, with all state/companion files; use an encrypted archive and never run original and restored copies together. Local locks do not coordinate copies. Policy binds to the server's agent UUID and environment, never a filesystem location. Earlier v1 ledgers fail closed without migration/reset: preserve them, never replace them with blank state under the same credentials.
- A separate `state.sqlite.owner` SQLite database holds a lifetime `BEGIN EXCLUSIVE` lock. A second owner is refused. Process death releases the OS lock; deleting the file is not lock recovery.
- SQLite uses WAL with `synchronous=FULL`, overriding the backend's `NORMAL` default. Power-loss durability still requires storage that honors fsync. Do not weaken synchronization or the owner lock.
- Agent files are strict (`spec.ts`): start from an `examples/` folder, add no extra fields to `agent.json`. Each agent's `agents/<id>/INSTRUCTIONS.md` opens that marketplace agent's system prompt; edit it only when the user asks to change who the agent is or what it wants. Suggest both spending limits for posting; without limits nothing caps commitments.
- Provider support comes from pinned Pi-ai 1.2.0. Read [Providers](docs/providers.md) for auth choices and gaps. No arbitrary provider module loading, package installs during setup or automatic conversion of old settings/state.
- Do not claim live staging or production validation from local tests. Ask permission for live work and report exactly what was exercised.

## Changing code

### Check your work

Node 24 and pnpm 12.12.1, as pinned in `package.json` and used by CI:

```bash
pnpm install --frozen-lockfile   # prepare builds dist/
pnpm typecheck
pnpm test
```

`pnpm check` is the single gate: typecheck, tests, the skill check, the prose-wrap check and the lessons-ledger check, in that order. CI runs the same gates as separate steps, so a red check there points at the one that failed.

`pnpm build` directly runs the TypeScript build. There is no actor build or generation step. Keep the lockfile in step with `package.json`. For policy or storage changes, include real persistent-store restart and ownership checks, not only mocked model calls. Keep live marketplace validation separate from local checks.

The terminal UI (`src/tui/`) is an opt-in Bun package with its own exact pins and `bun.lock`. Host code never imports it, and its pure modules import host code by type only. `pnpm typecheck` and `pnpm test` cover `screen.ts`, `keys.ts` and `link.ts`; `app.tsx` is checked only by `pnpm tui:test` (needs Bun), which CI does not run, so run it when you change the TUI or the console API. Never run `pnpm install` inside `src/tui/`.

### Rules the code depends on

- **Pi owns conversation, model and tool tasks.** `openMarketplaceAgent(AgentOptions)` in `agent.ts` opens persistent storage and one root conversation. No coding tools, child conversations or forks are enabled. Marketplace tools execute sequentially and policy serializes reservation through dispatch.
- **Policy is permanent and session-scoped.** `Policy` in `policy.ts` owns `actions`, spend by UTC day and notes. Conversation reset or compaction must never erase it. Keep action and daily spending records unbounded; never evict entries.
- **Reserve before dispatch.** Every write or money tool needs a meaningful action key. Policy commits the reservation and spending atomically before invoking the CLI. Reopening converts interrupted `reserved` actions to `uncertain`. No dispatch permission survives a restart.
- **Only a refusal is retried.** CLI outcomes are `ok`, `failed` (known refusal before acting) and `uncertain`. Only a known failure releases spending and permits another attempt. Success and uncertain actions never repeat. Register writes as unsafe to replay in Pi. Add an error code to `REFUSED` only if the CLI guarantees the server did nothing.
- **Code sets every amount, never the model.** A money tool declares an `amount` source read from the server by `amountOf` in `money.ts`. Policy checks limits at reservation and immediately before dispatch, including UTC-day rollover. Interrupted or uncertain reservations remain spent, even if dispatch might not have started.
- **Model values never become flags.** Validate tool inputs in `tools.ts`; pass them as `--name=value` options or positionals after `--`. Never splice raw input into arguments.
- **Artifacts are files the kit writes.** The model supplies a file's name and either its text or a `media:` handle the kit issued, never a path. `media.ts` saves a PNG, JPEG, GIF or WebP from an approved MCP tool's result under `.pi-state/media/<digest>.<ext>` only when its bytes match its type, and the handle names that file. `tools.ts` checks the name against one basename pattern, requires a media name to end in its handle's image type (the CLI sets the upload's type from the name), and builds the path under `.pi-state/artifacts/<task>/<content digest>/`. Policy writes or copies the file through `folderFile` before it reserves the action, and refuses a media file that is missing or no longer matches its digest. A refused `task submit --artifact` may already have uploaded, so policy deletes the agent's own uploads on the task before each submit with files. Remedy clears nothing, because the first delivery is also the agent's upload. Gate every cleanup delete through the tool invocation's bound commit and abort signal before dispatch; repeat-safe cleanup must still stop when the invocation is cancelled.
- **Console readiness is not agent readiness.** `run.ts` opens each folder independently after binding the console. Starting/stopped roster entries have no agent handle and cannot admit model messages. Retry and cancel belong to one folder and generation; retries wait for all prior cleanup, and failed cleanup blocks reopening. Openers must preserve `CleanupError` when cleanup fails before returning a handle, including after cancellation. Console mutations recheck readiness and generation after awaiting a request body or state read. Keep host facts cached and refresh remote reads in the background rather than delaying a basic view.
- **Console links identify destinations, never commands.** Keep the agent folder ID in `/agents/<id>` and page, capability and expanded-panel identities in query parameters. Never serialize token, editor, upload or message contents. Timeline references use the originating input's stable opaque ID and tool-call ID, never a visible row index: the server reads a moving transcript window. Missing or ambiguous references stay explicit rather than selecting another action. Navigation restores live data without running writes, connection tests or CLI previews.
- **ACK means durable admission, not model completion.** `deliver()` validates and stores the event before resolving. Preserve event-id deduplication and recovery of admitted work. The host closes streams before stores so it cannot acknowledge after ownership closes.
- **Skills are guidance, never permission.** `loadSkills` in `skills.ts` reads only the agent folder's `.agents/skills`, and `skill_read` takes a skill name and a file the skill lists, never a path. Skill text adds no tool, shell or policy exception, and `skill_read` never goes through the marketplace policy. A command a skill needs becomes a tool in `tools.ts` with its own action and money contract, and `SKILL_COMMANDS` then maps it.
- **The owner's fingerprint approves an MCP tool, nothing else.** `connectMcp` in `mcp.ts` registers only tools whose definition hash matches `mcp.json`, and refuses any approved tool its server marks as a write. Server annotations, descriptions and skill text approve nothing. MCP tools never go through the marketplace policy, stay `replay: "unsafe"`, and never reconnect or refresh their tool list while the agent runs. A local server gets only `PATH`, `HOME` and its own `.mcp.env` bindings (`inheritEnv: false`). Never log its stderr or an unredacted error.
- **One CLI child per command.** `runCli` uses the agent's config, `--env` before the subcommand and only `PATH`, `HOME`, `TASKFAST_CONFIG` in the child environment. Never pass through the host environment.

### Generated and captured files

- `providers.json` and `src/core/providers.ts` are generated. Change `scripts/gen-providers.mjs` and run `node scripts/gen-providers.mjs` against the installed exact Pi-ai pin (offline). Record intended provider or setting removals in `REMOVED` or `REMOVED_SETTINGS`. Do not hand-edit generated outputs.
- `test/fixtures/cli/` holds real CLI output. Re-capture when the CLI contract changes, as its README says. Never edit captures to make a test pass.
- `dist/` and every agent's `.pi-state/` are build and runtime output. Do not commit them or credentials.

### The server contract

No other repository imports this kit. `test/tools-contract.test.ts` checks the tool enums against `test/fixtures/openapi.yaml`, the spec that the taskfast-cli release named in that test vendors and checks against the live server. When a newer CLI release changes the spec, copy it over, update the tag and hash in the test, and fix any tool that no longer matches. When the pinned tag moves, also re-capture `test/fixtures/cli/surface.json` with `node scripts/capture-cli-surface.mjs`; the parity test (`test/cli-parity.test.ts`) then names any flag, value or command the tools and the CLI disagree on, and every command without a tool needs a reason in `EXCLUDED` (`test/cli-parity.ts`).

The runtime is Pi Durable; `durable-actors` and its Bun build are no longer used, so its old pinning and bump rules no longer apply. The Pi packages are experimental and pinned exactly to 1.2.0. Do not float versions. Bump them on their own, never as part of another change, and verify persistence, replay safety and provider support at any new pin. The one exception is the PR that replaced `durable-actors` with Pi (#9), which also moved pnpm 10 to 12 and added wallet unlock files and folder portability.

## Pull requests

- Never commit to main. Open one branch per change and send it as a pull request.
- Work each change in its own git worktree (the `.worktrees/<name>` convention), not the main checkout: other changes are routinely in flight there and their tooling rewrites shared files such as package.json mid-task.
- Fill every slot of [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) before you ask for review. Evidence classes: **A + D always** (body evidence, and the required `CI` workflow checks green), **B** for TUI or console changes (before/after screenshots or a GIF, committed under `docs/` and pinned to a commit SHA), **C** for logic, policy or money-math changes (one repro command).
- The commit message completes the sentence "... applying this change will ...".
- Keep lifecycle markers (`Part of #N`, `Closes #N`) out of code fences, including Mermaid diagrams.

## Writing style

For PR bodies, issues and comments:

- Use plain words: "use", not "utilize" or "leverage"; "help", not "facilitate".
- Write active voice and name the actor.
- No em dashes. End the sentence or use a comma.
- One idea per sentence. Split anything a reader has to parse twice.
- Sentence-case headings, straight quotes, no decorative emoji.
- Cut filler and puffery ("crucial", "delve", "in order to" is "to").
- Keep each paragraph on one line and let the renderer wrap; `scripts/check-prose-wraps.py` enforces this in agent-facing Markdown.

## Lessons

When a session teaches you a durable trap, record it in the same PR that learns it, per [.agents/lessons/README.md](.agents/lessons/README.md): a repeatable procedure becomes a skill, a rule tied to one code surface goes in `AGENTS.md`, a one-line trap becomes a topic file under `.agents/lessons/`, and something a test or lint rule could enforce becomes an issue proposing that check.
