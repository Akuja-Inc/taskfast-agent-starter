# Agent lessons

One-line traps and settled facts about working in this repository, written by the coding agents that hit them. Read this directory before you start work and again before you open a PR.

## Where lessons live

Lessons are added by hand, in the PR that learns them; there is no automation branch to wait for. Every learning lands in one of four forms:

| Shape of the learning | Where it goes |
|---|---|
| A repeatable multi-step procedure | A skill under `.agents/skills/<name>/SKILL.md` |
| A rule tied to one code surface | `AGENTS.md`, under the section that owns that surface |
| A one-line trap or fact | A topic file in this directory, `.agents/lessons/<topic>.md` |
| Something a test or lint rule could enforce | A GitHub issue proposing the check, with a one-line pointer here |

Topic files are created on demand. Each lesson is one bullet on one source line: the trap, the fix, and the provenance in parentheses. Example:

```
- `pnpm tui:test` needs Bun, which CI does not run; run it locally whenever `src/tui/` or the console API changes. (PR #12)
```

A lesson that would serve a task no single session sees can still become a skill: write the skill in the same PR and leave one pointer where the trap stood.

## Ledger

`LEDGER.tsv` records every source item judged and what was done with it, so nothing is proposed twice. The ledger's contract is defined and enforced by `scripts/check-lessons-ledger.py`, which `pnpm check` runs: the six columns, the `source_id` key formats (the checker's docstring lists them), uniqueness of `source_id`, UTC timestamps, the disposition names, and that every non-discard row's `target` is a tracked path or a repository issue URL. Run it before you commit a ledger change; `scripts/test-lessons-ledger.sh` is its regression suite.

## What never goes here

- Claims about the state of a PR, issue, or release. Those go stale and mislead.
- Anything about one machine's environment (tool paths, hosts). That belongs in that coding agent's own memory.
- Lessons about tooling this repository no longer uses. Before promoting a lesson about a tool, `git grep` main for it and discard when the only hits are removal notes.
