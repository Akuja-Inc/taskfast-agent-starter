---
name: ship-pr
description: >-
  Take a change in this starter kit from request to an opened pull request: fetch
  the latest main, branch per change, implement test-first where the change allows,
  run `pnpm check`, capture proof of work, and open the PR from
  `.github/PULL_REQUEST_TEMPLATE.md` with every slot filled. Use when asked to ship
  a PR, open a PR for a change, or take a branch to merge-ready in this repo.
  NOT for watching, fixing or merging a PR that is already open (use landing-a-pr).
  NOT for creating or configuring an agent (use setting-up-an-agent), or starting,
  watching or fixing a running one (use running-an-agent).
---

# Ship a PR

This skill takes one change from a clean main checkout to an opened pull request, and stops there: watching checks, answering review comments and merging belong to `landing-a-pr`.

## 1. Start from a clean main checkout

`git fetch origin main`, then create one branch per change off `origin/main` and switch to it. Confirm `git branch --show-current` does not print `main`; never commit to main. If the work already sits on a branch, rebase it onto the fresh `origin/main` so the later push is fast-forward. Run `gh pr list` first so you do not duplicate a PR that already covers the same change.

## 2. Implement test-first where the change allows

Write the failing vitest case first, then the code that passes it. Read `AGENTS.md` ("Rules the code depends on") before touching `src/core/`, and `INTENT.md` for what to choose when a change is unclear; a design choice the request does not settle goes back to the user with each option's pro and con. For policy or storage changes, cover persistent-store restart and ownership checks, not only mocked model calls. Keep a clarity pass in its own PR (use `simplify`), not mixed into this change.

## 3. Run `pnpm check`

`pnpm check` is the composite gate: typecheck, test, the skill check, the prose-wrap check and the lessons-ledger check. Fix everything it reports before committing. `pnpm typecheck` and `pnpm test` alone are not the gate.

## 4. Generated and captured files

`providers.json` and `src/core/providers.ts` are generated: change `scripts/gen-providers.mjs` and run `node scripts/gen-providers.mjs`, never the outputs. `test/fixtures/cli/` holds real CLI output: re-capture it the way its README says when the CLI contract changes, and never edit a capture to make a test pass.

## 5. Capture proof of work

`.github/PULL_REQUEST_TEMPLATE.md` defines the evidence classes and owns their exact slot wording, including the N/A wording for a class that does not apply. Fill every slot:

| Class | When | What |
|---|---|---|
| A | Always | Body evidence: the Summary, the source-issue marker, the Mermaid diagram, the `pnpm check` result and the Contract proof. |
| B | TUI or console changes | A screenshot under `docs/`, pinned to the commit SHA it was captured at. |
| C | Logic, policy or money-math changes | One repro command another person can run. |
| D | Always | Gates: the PR's required `CI` workflow checks green. |

Never claim live staging or production validation from local tests. A live run needs the user's permission in this request, and the PR reports exactly what was exercised, nothing more.

## 6. Commit

The commit message must complete the sentence "... applying this change will ...", for example "applying this change will refuse absolute wallet references at startup". Before committing, `git status` shows only what you mean to commit, and the staged diff contains no credentials, no agent folders and no live state.

## 7. Open the PR

Open it with `gh pr create`, using `.github/PULL_REQUEST_TEMPLATE.md` as the body with every slot filled. Keep `Closes #N` and `Part of #N` markers out of fenced code blocks: tooling reads them only outside a fence. Report the PR URL and stop there. When the user wants it merged, watched or its comments answered, continue with `landing-a-pr`.
