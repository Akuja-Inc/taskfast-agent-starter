name: code-review
description: Review documented standards compliance and issue/PRD/spec compliance as separate axes. Use when the user explicitly asks for standards/spec compliance, a two-axis Standards and Spec review, or invokes code-review by name. Do NOT trigger for generic code, diff, branch, PR, WIP, or "review since X" requests; those use code-review-pro. Uses independent sub-agents when available, with a labeled direct-execution fallback.
---

Two-axis review of the user's selected change set:

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / PRD / spec?

Run the axes as **parallel sub-agents** when available, then aggregate their findings. If delegation is unavailable or quota-limited, execute the axes directly and label the lack of independent review.

Read existing repo guidance, including `docs/agents/issue-tracker.md` if present. Use the configured tracker, `gh` for a GitHub repo when available, or a supplied spec. Do not require a setup skill or new configuration. Missing or inaccessible evidence is a report limitation, not a blocker for the available review.

## Process

### 1. Pin the scope and baseline

Establish whether the user wants committed branch/PR changes, complete WIP, local-only changes, or staged-only changes. Infer the base from explicit input or reliable PR/repo guidance; ask if ambiguous. A local-only or staged-only review needs no branch base. Run from the repository root and record any path restrictions.

Inventory the checkout with `git status --porcelain=v1 -z` and `git ls-files --others --exclude-standard -z`. Parse NUL-delimited paths, including rename records, without splitting on whitespace. Pin `HEAD_SHA=$(git rev-parse --verify 'HEAD^{commit}')`. For branch/PR or complete WIP scope, also pin `FIXED_SHA=$(git rev-parse --verify "${FIXED_POINT}^{commit}")` and `BASE_SHA=$(git merge-base "$FIXED_SHA" "$HEAD_SHA")`. If the user explicitly wants comparison against an exact commit rather than its merge-base, set `BASE_SHA=$FIXED_SHA` and say so. Check each command's exit status before continuing; record the resolved SHAs, not just movable ref names.

Use the selected comparison, appending scoped pathspecs after `--` when needed:

| Scope | Tracked diff |
|---|---|
| Committed branch/PR since merge-base | `git diff "$BASE_SHA" "$HEAD_SHA" --` |
| Complete WIP from merge-base through working tree | `git diff "$BASE_SHA" --` |
| Local-only, staged and unstaged against pinned HEAD | `git diff "$HEAD_SHA" --` |
| Explicit staged-only | `git diff --cached "$HEAD_SHA" --` |

For complete WIP and local-only reviews, also capture `git diff --cached "$HEAD_SHA" --` and `git diff --`. These preserve staged and unstaged changes that cancel in the net working-tree diff. Review both states, label which contains a finding, and deduplicate overlapping findings. For scopes with a branch baseline, record `git log "$BASE_SHA..$HEAD_SHA" --oneline`. Do not include branch commits in a local-only review's spec searchby default.

Diffs do not include untracked contents. For WIP and local-only scope, read every scoped untracked file directly, without staging it. For committed and staged-only scopes, exclude untracked files explicitly. Report all scope exclusions and unreadable, binary, ignored, or otherwise unreviewed content; ignored files are outside the inventory unless explicitly requested. An empty tracked diff is not an empty review when scoped untracked files exist. Only report "no changes in scope" after checking both.

An unborn branch has no HEAD commit. For local/WIP review, use `git diff --cached --` for initial staged additions, `git diff --` for unstaged changes, and direct reads of scoped untracked files. Staged-only uses only`git diff --cached --`. Report that no branch baseline or commit log exists. For committed review, report no commits to review. If HEAD is unresolvable for another reason, or a requested base or merge-base cannot resolve, report the failed command and request a valid target rather than silently changing scope.

Preserve the user's index and working tree. Never stage, stash, reset, or use `git add -N` merely to review. Before reporting, recheck pinned HEAD, status, the selected diffs, and scoped untracked contents for drift. If they changed during review, refresh affected evidence or label the review incomplete. Pass the same captured scope and evidence to both axes.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. A spec or path the user supplied.
2. Issue references in the scoped commit messages or PR (`#123`, `Closes #45`, GitLab `!67`, etc.). Fetch through existing tracker guidance or available configured tooling. Do not infer a tracker solely from a reference number.
3. A PRD/spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found or access fails, ask for a source without blocking the Standards review. The **Spec** axis reports "no spec available" or the specific evidence gap. Do not treat missing evidence as a pass.

### 3. Identify the standards sources

Read applicable repo guidance, including root and scoped `AGENTS.md`, `CODING_STANDARDS.md`, and `CONTRIBUTING.md` when present. Inspect formatter, linter, compiler, and CI configuration to identify checks tooling already enforces.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below — a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation — and, like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Review both axes

When `Agent` is available and quota permits, send a single message with two `Agent` tool calls. Use the `general-purpose` subagent for both. If the tool is unavailable or delegation fails due to quota, run the affected axes directly using the same briefs below. Retain any completed independent report. Label each axis's execution mode and state "No independent review" for any directly executed axis. Do not require setup or retry indefinitely.

**Standards sub-agent prompt** — include:

- The pinned SHAs, scope, captured diffs and commit list, plus scoped untracked contents and exclusions from step 1.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full — the sub-agent has no other access to it.
- The brief: "Report — per file/hunk where relevant — (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls — documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** — include:

- The same pinned SHAs, scope, captured diffs and commit list, plus scoped untracked contents and exclusions from step 1.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementationlooks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

First state the reviewed scope, pinned SHAs, execution modes, and coverage limitations or exclusions. Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings — the two axes are deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes — that's the reranking the separation exists to prevent.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.
