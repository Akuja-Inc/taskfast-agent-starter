# Plan: inherit Pi's compaction defaults (#40)

## Owner decision

The owner replaced #40's original percentage-policy proposal with a test/docs change. Agents inherit the pinned Pi Durable defaults. Do not add the 300,000-token split, a `compaction` agent-file field or a setup flag. Defer custom configuration until there is a concrete need.

The [revised issue contract](https://github.com/Akuja-Inc/taskfast-agent-starter/issues/40#issuecomment-6181209203) records this decision. The original plan's startup-validation question no longer applies because no new field is added. Host startup behavior stays unchanged.

## Scope

1. Add successful automatic-compaction tests at the existing `openMarketplaceAgent` boundary, using faux model responses, fake CLI commands and real temporary SQLite stores. Do not substitute manual `compact()` for threshold coverage.
2. Cover both a 128,000-token model and the 32,768-token local-model window. Preserve Pi's recent-token and background defaults in both cases.
3. Hold a summary response to prove a blocking compaction prevents the next normal model request. Inspect the public live document for reason `threshold`, then verify the durable `pi.compaction` entry.
4. Verify actions, UTC-day spend, notes, pause/freeze controls and standing orders survive compaction and reopening. Unfreeze before retrying a completed write so the freeze cannot hide a lost ledger; assert the CLI dispatched the write only once.
5. Cover the background threshold separately: a request below it does not compact, while a request above it but below the blocking threshold proceeds while its summary is pending.
6. Document inherited defaults and their small-window tradeoff in `README.md`; define compaction in `CONTEXT.md` and record ownership of the defaults in `INTENT.md`.

## Validation

- `pnpm install --frozen-lockfile` with Node 24 and pnpm 12.12.1.
- Targeted repro: `pnpm exec vitest run src/core/agent.test.ts -t 'Pi defaults|background threshold'`.
- Check test sensitivity by temporarily disabling automatic compaction, require the new tests to fail, then restore the runtime source. No mutation ships.
- Run `src/core/agent.test.ts`, `src/core/operator.test.ts`, `src/core/storage.test.ts` and `test/runtime-crash.test.ts` together, then the complete `pnpm check` gate.
- No console API or TUI changes, so no visual evidence or Bun smoke test is required. No live marketplace/provider calls are authorized or claimed.

## PR boundary

Work on branch `gh40-compaction` in `.worktrees/gh40-compaction`. Leave the main checkout's unrelated work alone. Keep runtime source, setup, schemas, example agents, generated files, captured fixtures and package pins unchanged.

Fill every PR template section. Use `Closes #40` and `Refs #38` outside fences. This test/docs PR has no behavior delta, so the architecture-diagram section is N/A. Include the reproducible test command and actual gate results. Open as draft until required CI checks are green, then request review. Do not merge.
