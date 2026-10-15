# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The designable surface is the local browser console (`pnpm agents --console`, a single page served by the host on `127.0.0.1`). The terminal UI (`pnpm tui`) is a separate Bun/OpenTUI client of the same console API, not a second design language. Platform recorded as `web` because the console is the web surface; the terminal client is noted here so later work does not mistake it for a native platform.

## Users

- **Primary: the TaskFast user who owns an agent.** They want a marketplace agent that posts jobs, takes jobs, or both, running under their own TaskFast account, wallet and model credentials. They may not write code; if they do, they want to change how the agent decides, not just what it is called. They act in two ways: directly at a terminal, or by delegating to a coding agent (Claude Code, OpenAI Codex, pi, GitHub Copilot) that reads this repository's guidance files and runs the same commands. (Source: INTENT.md.)
- **Secondary: TaskFast downstream tooling maintainers.** They pin this repository by exact commit and import its core modules (`agent`, `policy`, `storage`) as a library surface. Changes must not break that pin contract silently. (Source: README.md "Maintainers", INTENT.md.)

## Product Purpose

Let a TaskFast user go from an empty folder to their own locally running, marketplace agent in three commands (`pnpm install --frozen-lockfile`, `pnpm setup-agent`, `pnpm agents`), and keep that agent safe while it bids, posts, works and settles with real money on production. Success means: the human path and the coding-agent path are both short and both safe, and the agent's money actions are conservative-at-most-once even across restarts. (Source: INTENT.md, README.md.)

## Positioning

The kit's durable money-safety architecture: every write is identified by an action key, reserved and committed in a permanent ledger before the CLI runs, with amounts set by code from server data, and an interrupted or uncertain write is never repeated. Combined with "one folder is one agent" (a stopped, archived, moved folder is the same agent, ledger intact) and "the user holds everything" (no custody of keys, wallet or funds). A neighboring agent framework could copy the feature list but could not truthfully claim restart-safe, ledger-backed money dispatch or zero-custody operation without adopting the same architecture. (Source: INTENT.md principles, CONTEXT.md, README.md "What the agent does".)

## Operating Context

- Runs entirely on the user's local machine. Node 24 and pnpm 12.12.1 pinned in `package.json`; no separate runtime server, Bun build or generation step in the setup path. The `taskfast` CLI (0.19.0+) is the only way the agent reaches the server; each command is a child process with a restricted environment.
- Environments: `production` (default, real money), `staging` (testnet, free test funds), `development` (local server at `127.0.0.1:4000`).
- Each agent lives in a self-contained folder: `agents/<id>/agent.json`, `agents/<id>/INSTRUCTIONS.md` (the agent's instructions), private `.env`, `.taskfast/` credentials and wallet, `.pi-state/<cli-env>/state.sqlite` with WAL + `synchronous=FULL` and a single-owner lock. Local disk that honors fsync; no network filesystems.
- Wallet signing uses a user-created `agents/<id>/.taskfast/wallet-password` file (mode 0400); the host never reads or forwards the password.
- The host (`pnpm agents`) owns stores, event streams and 15-minute polling in one process. The console is opt-in (`--console`, port 7070, per-start token, `127.0.0.1` only, reads through the running host, never the store). The TUI is a Bun client of the console API for SSH/tmux.
- The user watches and steers agents through the console or TUI: timeline, attention alerts, pause, freeze spending, messages, standing orders, briefing editor.

## Capabilities and Constraints

- Agents only: real bids, work and settlement, as an ordinary marketplace user would.
- Pi Durable owns the conversation, model and tool tasks; the kit owns marketplace policy (action keys, spend by UTC day, notes), session-scoped and surviving conversation reset/compaction. No coding tools, child conversations or forks.
- Money: code sets every amount from server data; policy checks limits at reservation and at dispatch; only a known refusal before acting releases spending and permits retry; success and uncertain outcomes never repeat; ledgers and daily spend records are permanent and unbounded.
- Event handling: admission after durable local storage, event-id deduplication, dead-letter file for repeatedly failing events, recovery of admitted work without granting permission to repeat an uncertain write.
- Agent files (`agent.json`) are strict: unknown fields refused; `examples/` are the starting points; posting agents should carry both `perJobUsd` and `dailyUsd` limits.
- Provider support is bounded by the pinned `@earendil-works/pi-ai@1.2.0` catalog (`providers.json`, generated); no arbitrary provider modules, no installs during setup, no automatic conversion of old settings or state.
- One local owner per store; no shared-disk or multi-process deployment. Never delete or copy a live store or companion files.
- Downstream pin contract: exports are `agent`, `policy`, `storage`; removed `actors`/`self`/`turn` exports have no legacy adapters. Tool enums must match the vendored server spec (`test/tools-contract.test.ts`).
- Local checks do not establish live staging or production readiness; live work requires explicit permission and exact reporting.
- The console supports both dark and light themes. (Confirmed by the user, 2026-10-13.)

## Brand Commitments

- Repository and package name: **taskfast-agent-starter** ("TaskFast agent starter"). TaskFast is an Akuja Inc product; this kit is its official starter. License: MIT.
- Voice established by the docs: plain, precise, safety-first; concrete commands over abstraction; never promises validation that was not performed ("Running a process is not proof…").
- Foundational framing: "Every agent here is honest." Production is real money and is never the unspoken default.
- No logo, wordmark or brand asset kit exists in the repository; the only visual record is the console/TUI screenshots under `docs/`.

## Evidence on Hand

- Product-truth documents: `README.md`, `INTENT.md`, `CONTEXT.md`, `AGENTS.md` (repo root).
- Real product imagery: `docs/console/*.png` (timeline, tool calls, raw event, paused+frozen, briefing, unlock, copy feedback, phone) and `docs/tui/*.png` (timeline, tool calls, confirms, paused+frozen, help, narrow layouts, can't-reach).
- Example agent folders: `examples/careful-worker/`, `examples/brisk-poster/`, `examples/both-sides/`.
- Provider support matrix: `docs/providers.md`; generated catalog `providers.json`.
- Real CLI output captures: `test/fixtures/cli/` (re-captured on contract change, never hand-edited).
- Live agent folder in development: `agents/foo/` (private; never printed, committed or copied).
- Absences future work must not fabricate: no marketing site or landing page, no testimonials or customer stories, no performance benchmarks, no logo assets, no pricing.

## Product Principles

1. **Short and safe on both paths.** A person at a terminal and a coding agent run the same commands; every setup question has a flag. Neither path depends on the other; every added step must earn its cost.
2. **The user holds everything.** Accounts, wallets, TaskFast keys and model credentials stay on the user's machine. Nothing in the kit holds money or secrets for them, and private files are never printed, committed or copied.
3. **Code sets money; safety survives restarts.** Amounts come from the server, reservations commit before dispatch, the ledger is permanent, and an uncertain write is never retried, including across process death.
4. **Agents only, production never implied.** The kit builds agents that act as ordinary marketplace users; real-money environments require explicit intent.
5. **One folder is one agent.** Behavior, credentials, wallet and durable history stay together; a moved or archived folder is the same agent, and a copy is never permission to run twice.
