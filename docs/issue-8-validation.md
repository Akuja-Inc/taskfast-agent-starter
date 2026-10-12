# Issue 8 validation

## Implementation

The shipped host uses Pi Durable, Pi-ai and Chord pinned at **1.1.0**. Marketplace policy is session-scoped, independent of the conversation transcript. SQLite is opened with WAL and `synchronous=FULL`; a separate SQLite database holds the process-lifetime owner lock. Forks and child conversations are disabled. There is no old-runtime adapter or state importer.

Breaking package changes: `actors`, `self`, `turn`, `PersonaActor`, `loadModel` and `setModelFactory` are removed. Hosts use `openMarketplaceAgent` from `/agent` and `startListener` from `/listener`, and close streams before stores. `/model` exposes `createAgentModels`. `/policy` and `/storage` expose the policy and storage boundaries. Tool enum values and CLI command names are unchanged; UUID inputs are normalized so casing cannot change an action's identity. Write/money tools must now provide an action key at compile time.

## Local evidence

Environment: Node **24.21.0**, pnpm **10.20.0**, local Linux filesystem. No Bun or separate execution server is used.

Commands:

```bash
pnpm install --frozen-lockfile  # prepare builds emitted JS
pnpm typecheck
pnpm test
```

Initial migration result: frozen installation/build, typecheck and **176 tests across 13 files passed**. The three-role noninteractive setup command also ran successfully in a fresh temporary sandbox with Ollama and `--no-init`; no account, wallet or live model was provisioned.

Behavior exercised through real Pi conversations/tasks and real file-backed SQLite:

- `test/runtime-crash.test.ts`: real child processes are killed with SIGKILL before application intent, after intent/before dispatch, after external acceptance/before result commit, and after result commit. A synced receipt file models the unavailable marketplace service. Reopened processes make fresh tool calls; successful and uncertain business keys never dispatch again. Reservations are counted as spent. A crash before intent permits a new attempt. Competing process owners are rejected; SIGKILL releases ownership without deleting files.
- `src/core/agent.test.ts`: tool schemas, sequential money rounds against daily limits, proven refusals versus uncertainty, server-derived fees, UTC-day rollover, counterparty refusal, durable event admission while a model is blocked, notes and policy persistence after reset/reopen, actual transcript compaction, disabled forks. An abort-during-fee-read regression first reproduced an unwanted post, then passed after binding policy writes to Pi's invocation commit and checking cancellation before dispatch. A separate abort-after-dispatch test proves commitments remain counted and the key remains blocked.
- `test/event-lifecycle.test.ts`: actual event-stream child processes ACK only after admission, do not ACK failed admission, restart and deduplicate replays, recover failed model runs and queued events, resume admitted work after reopening, poll after host restart, and close stores/children after abort or partial startup failure.
- `src/core/storage.test.ts`: reopen and owner exclusion using the real persistent backend.
- `src/core/model.test.ts`, `test/setup.test.ts`: native catalogue/model lookup and aliases, supported auth-setting alternatives, fresh noninteractive setup, strict input rejection before side effects, private local credentials, and an actual local Ollama-compatible HTTP request. Cloud/model account access is not established by catalogue tests.
- Existing money, argument construction, prompt, spec and captured CLI-output tests remain. The honest-kit scan is unchanged apart from output-directory exclusions.

`docs/providers.md` records every former provider's status and changed settings. Five former providers have no supported native equivalent; OAuth login/storage is not implemented. Supported model construction is tested, but live authentication for every provider is not claimed.

## Development readiness evidence

The user's exported `TASKFAST_PAT` authenticated on the real development server (`http://127.0.0.1:4000/api/users/me`, HTTP 200). No production request was made. A fresh sandbox at `/tmp/taskfast-issue8-development-D5gwvP` retained its newly created credentials and stores; no existing user agent/config/state was copied or reused.

`node /tmp/issue8-local-readiness.mjs` ran noninteractive setup with `--env development --provider deepseek --model deepseek-flash --no-init` for worker, poster and both roles. The CLI initialized each account with `--env local init --skip-wallet --no-interactive` using the exported personal token only for enrollment. Pi used the native DeepSeek model, the real CLI and file-backed SQLite. Each role completed `me` and `task list` successfully: **six successful marketplace reads**, no run timeouts and no diagnostics. All three stores closed and reopened. The poster recorded one note and retained it after reopen; the other roles did not record notes. Ledgers were empty because this phase deliberately refused writes at the command boundary. The controlled report is at the sandbox's `readiness-report.json`.

After the host-only wallet-file addition, frozen installation/build, typecheck and **184 tests across 14 files passed**. Three regression slices first failed for missing CLI forwarding, dropped agent runtime options and dropped host runtime options, then passed. Real child-process tests verify option placement before `--`, signing-command selection, no extra environment keys, unchanged unsigned/default behavior and pre-spawn refusal of malformed paths. The compiled startup command accepted `--env development --wallet-password-file relative-wallet.pw` and reached its expected empty-agent-directory error in a fresh temporary root. These argument tests do not establish actual wallet signing.

This establishes fresh enrollment, live model/tool reads and reopen, not posting, bidding, funding, settlement or listener/recovery evidence against the real marketplace. Wallets were deliberately not provisioned. The script had two corrected setup/control-flow errors before its successful run (the profile's nested identity and the requirement for positive spending limits); no uncertain account mint was retried.

## Outstanding evidence — do not close issue 8 yet

- **Real marketplace validation remains incomplete.** Issue 8 now accepts development or staging. The user's exported PAT authenticated successfully against `http://127.0.0.1:4000/api/users/me` (HTTP 200); it is not a staging credential. Development validation must use fresh worker, poster and both-role accounts, not copy or reuse existing configs. The bounded read-only readiness run above does not by itself satisfy the three-role marketplace requirement. User-owned wallet provisioning/unlock and test funding remain necessary.
- Money-tool tests prove policy dispatch, not wallet signing. Host-only `--wallet-password-file` support now passes an absolute user-owned file path to the existing signing commands; the child environment still contains only PATH, HOME and TASKFAST_CONFIG. The user must create/provide the password file before real wallet initialization/signing can be checked. No password has been generated or injected into a child environment.
- The coordinated TaskFast integration is prepared on branch `issue-8-pi-integration` in its own worktree. It replaces generated/source-copy execution with compiled package imports, opens local agents with current counterparties, owns stream/shutdown lifetime, and removes the old dependency/build steps. Its package typecheck and 47 focused tests passed, including the two unchanged server OpenAPI tool-contract tests; its delegated full run passed 199 tests. Validation used a temporary local package dependency. The final GitHub commit pin, matching lockfile and remote-package frozen installation remain pending publication; no temporary local dependency should be committed.
- Power/host failure is not simulated. SQLite FULL requests WAL synchronization on every commit, subject to filesystem/device fsync guarantees. Process-crash evidence does not establish hardware power-loss behavior. Use local disk only; do not copy/delete live stores or bypass their owner locks.

## Review

Independent Standards and Spec reviews covered the complete starter worktree against base `48c3c3f2abbc4c6303a2e38b95deed4f50f38a07`, including every untracked source/test/document. Catalogue IDs and lock metadata were sampled; their generation logic was reviewed. Credentials, user agents and build/state output were excluded.

The confirmed cancellation bug was fixed and regression-tested. Other fixes made event lifecycle variants explicit, validated test JSON at its boundary, gave added multi-argument helpers named arguments, and removed duplicated environment translation. The escaped upstream import was removed: the exact pinned package's unique runtime factory is selected by its public `open` contract, with a fail-closed uniqueness check. No private-name regex was relaxed. Duplicate faux-model setup in separate test files remains a low-risk advisory, not a correctness blocker. Review-fix verification used tests and direct inspection; a separate independent re-review was unavailable after the review agents were released.

Two separate subagents reviewed the wallet-file/readiness continuation against `01a7cc6c446a50ed0d5b5f457ab93fab22c47d86`, including all local tracked changes and the untracked CLI test. Sensitive/generated/runtime output and the external sandbox were excluded. Standards reported no violations or actionable smells. Spec reported no wrong implementation or scope creep, but retained the two delivery gaps: real three-role signed marketplace behavior and the published downstream pin/install. The final test-count/startup-result metadata above was added after that review; code did not change.

No production validation was requested or performed. These local tests are not evidence that all issue acceptance criteria are complete.
