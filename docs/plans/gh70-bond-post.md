# Plan: let a worker post the performance bond (#70)

Status: approved in Plannotator before implementation, with the captures attached to the review. This PR is the implementation; the captures sit in `test/fixtures/cli/gh70/`.
Source: [issue #70](https://github.com/Akuja-Inc/taskfast-agent-starter/issues/70), `Refs #64`. The settled contract is recorded in [issue #70's contract comment](https://github.com/Akuja-Inc/taskfast-agent-starter/issues/70#issuecomment-6205505494).

## Outcome

A worker can take a stake-tier (>= $1) task on its own. When `task_claim` is refused with `bond_pending`, the agent reads the required stake from the server, posts it once, and claims again. Neither the amount nor the contract address comes from the model, from task content or from a message.

The kit stops telling the model that work needing a bond is off limits.

## What the captures show

Five captures of the real `taskfast` 0.19.7 binary against a stand-in server on `127.0.0.1:4123` that answers the documented shapes, with a throwaway keystore. No chain and no marketplace account was touched. They live in `/tmp/gh70/captures` during review and belong under `test/fixtures/cli/gh70/` in slice 1, with the re-capture script beside them.

1. `bond-dry-run`: `taskfast bond post <task_id> --dry-run` returns `data.amount` (the quote's `required_amount`, int64 bond base units), plus `action: "would_post_bond"`, `task_bond`, `token`, `chain_id`, `rpc_url`, `salt` and `task_ref`. Its request log shows one quote `GET` and one `GET /config/network` and nothing else: no RPC call, no mutation. The CLI does decrypt the keystore, so the read needs `--keystore` and `--wallet-password-file`.
2. `claim-bond-pending`: `taskfast task claim` on a 409 `bond_pending` prints `error.code = "validation"`, with the server's code only in the message text. `bond_pending` never reaches the kit as a code of its own, and `validation` is already in `REFUSED`. The claim is therefore already recorded `failed` and retryable today, with no change to the kit.
3. `bond-report-posting-disabled`: the trap. When `POST /tasks/{task_id}/stake/report` is refused, the CLI has already sent and confirmed the `TaskBond.post` transaction (the request log shows `eth_sendRawTransaction` then `eth_getTransactionReceipt` before the report), yet it prints `error.code = "validation"`. A 403 at the report step prints `auth`. Both codes are in `REFUSED`, so today's policy would record the action `failed`, release the amount and permit a repeat that posts a second bond.
4. `bond-preflight-balance`: a wallet below the bond is refused before any transaction as `usage: poster balance 1 < required bond 2500000 on token ...`. The CLI's own preflight codes are safe refusals.
5. `cast-decimals`: `taskfast cast call <token> "decimals()(uint8)"` returns `data.decoded[0]`, a read that needs no wallet and no funds.

Two smaller findings from the same session. `--amount` below the quote is refused with `usage` before the chain is touched. `--task-bond` overrides the deployment address, so an address the model controls can reach an arbitrary contract.

## Decisions

**D1. One new money tool, `bond_post`.** Its schema is `{ task_id }` only. It runs `taskfast bond post -- <task_id>`. Action key `bond:<task_id>`, so one post per task. Amount source `bondStake`. No `--task-bond`, no `--token`, no `--amount`, no `--source`.

**D2. The amount is the server's quote, read by code.** `amountOf("bondStake", ...)` runs `bond post <task_id> --dry-run`, requires `data.action === "would_post_bond"` and a positive integer `data.amount`, then runs `cast call <data.token> "decimals()(uint8)"` and divides. It returns USD for the limits. Either read failing, a missing or unusable `amount`, or a `decimals` outside 0 to 36 refuses the tool. The model supplies only the task id.

Leaving out `--amount` keeps the CLI's own quote authoritative for the transfer. The quote freezes when a bond row exists and is priced from the task's fixed accepted-bid value, so the read and the CLI's internal quote agree. Pinning `--amount` to the read would need a money tool to build arguments after the amount is fixed, which the tool table does not support today; the evidence says it would at least fail safely (`usage`, pre-chain). Note it as an option, not part of slice 1.

**D3. A refundable bond counts as spend.** The wallet must hold the bond plus gas, and the funds stay committed until clean settlement, so the bond competes with everything else the agent commits that day. The per-job and daily checks count it when the action is reserved. A later refund does not credit the day back: action records are never evicted, and `account` already counts `done` and `uncertain`. Add one sentence to the `Limits` comment in `types.ts` and to `CONTEXT.md` saying a bond is spend while it is at risk.

**D4. `bond_post` never treats a dispatch failure as a known refusal.** Do not touch `REFUSED`: `bond_pending` already arrives as `validation`, and the codes the bond command prints cannot distinguish "refused before the chain" from "refused after the post" (finding 3). Add a money-tool flag, `spendAfterPreflight` in this draft, and have `policy.ts` store a `failed` dispatch of such a tool as `uncertain`. The dry run in D2 is the preflight: it proves the quote, network, balance and allowance checks passed, so a failure of the real dispatch happens at or after the approve or post transaction, and the funds may have moved. `uncertain` keeps the spend committed and forbids a repeat, which is the conservative side and the only honest one here. `usage`/`config`/`keystore`/`signing` failures still leave the wallet untouched, but losing a retry on those is the price of never double-posting a bond; the dry run catches them first in practice.

**D5. Bidding on stake-tier work stays allowed.** A useful pre-bid funds check does not exist: pricing is per task, and the quote may not price before a bond row or a direct agent exists (`not_high_assurance`). Bidding commits nothing, so the agent may bid; the bond is due at claim. When the wallet cannot cover the bond plus gas the post is refused before the chain, and the agent keeps a note that the console already shows. This keeps the agent out of work it can afford most of the time, and accepts the rare task it wins and cannot bond for.

**D6. The wallet unlock list grows.** `runCli` injects `--wallet-password-file` only for `post`, `settle` and `escrow sign`. Add `bond post`, because both the dry-run read and the real post decrypt the keystore. If the host unlocks the wallet another way (no password file), the read fails closed with `usage` and the tool refuses, the same as the post would.

**D7. Pass no `--wallet-address`.** The captures show the CLI preflights the wallet balance and allowance on its own and needs only the keystore and its password. Passing the address would repeat a check the CLI already does and add a value the kit would have to read and forward.

## One upstream ask, not a blocker

A `taskfast bond quote <task_id>` read would serve D2 without decrypting the keystore. File it with taskfast-cli and keep the dry-run read until it exists.

## Work plan

Slice 1, the read and the amount:
1. Move the five captures under `test/fixtures/cli/gh70/` with the re-capture script, and extend `test/fixtures/cli/README.md`.
2. Add `bondStake` to `AmountSource` and to `amountOf` in `money.ts`, with tests over the real captures: a usable quote, a dry run that did not short-circuit, a quote with no amount, a `decimals` read that fails, a `decimals` outside range.
3. Add a contract test that `bond_post`'s schema and the quote fields match `test/fixtures/openapi.yaml`.

Slice 2, the tool and the ledger:
4. Add `bond_post` to `TOOLS` (D1) and `"bond post": "bond_post"` to `SKILL_COMMANDS`; drop `bond` from `UNSUPPORTED_COMMANDS`.
5. Add `spendAfterPreflight` to the money tool type and the `uncertain` rule to `policy.ts` (D4).
6. Extend the `--wallet-password-file` list to `bond post` (D6).
7. Tests: a refused claim is retryable and the retry after a confirmed bond is allowed; a `failed` `bond_post` dispatch is stored `uncertain` and never repeats; a reserved bond survives a store reopen as `uncertain`; a bond counts against `perJobUsd` and `dailyUsd` and the day rolls over; an over-limit or unreadable-quote bond is refused before dispatch.

Slice 3, guidance:
8. Update the system prompt in `skillsPrompt`, the README paragraph and `CONTEXT.md`. The prompt no longer calls work needing a bond off limits, and it says a bond is spend. Record any new choice in `INTENT.md`.

## Validation

- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, then `pnpm check`.
- Targeted repros: the new `money.test.ts` capture cases and the policy `uncertain` test, both runnable with no network.
- Persistence: a real SQLite store, a fake CLI and a reserved bond across reopen, not only mocked calls.
- Evidence class C: one repro command in the PR. No console or TUI change, so no screenshots.
- Live: a staging bond post spends real test funds and needs the owner's permission. Report exactly what was exercised; claim no production validation.

## PR boundary

One PR against `main`, `Refs #70`. Use `Closes #70` only if the live staging post is exercised. The captures and the contract test come first, so a reviewer can see the CLI evidence the amount and the `uncertain` rule rest on.
