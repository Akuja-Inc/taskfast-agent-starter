---
name: landing-a-pr
description: >-
  Watch, fix and merge a pull request that is already open in this repo: follow
  `gh pr checks`, read and answer review comments, push fix commits, and run
  `gh pr merge` only when every required check is green and the user asked for the
  merge in this request. Use when asked to watch a PR until it merges, babysit it
  through CI and review comments, or merge it once the checks pass.
  NOT for opening the PR (use ship-pr).
---

# Land a PR

The PR is already open; `ship-pr` opened it and hands off here. This repo has no merge queue and no model review gate. The gates are the required CI checks and the human review comments, and merging itself is never a default action: it needs the user's ask in this request.

## Steps

1. Read the merge policy from the user's ask, and default to this one: every required check green, no review thread left unanswered, and an explicit ask to merge. Do not ask again when the ask already states it. If the user only asked you to watch or to fix, stop at that.

2. Check the PR can get CI runs at all: `gh pr view N --json mergeable,mergeStateStatus,headRefOid`. `mergeable` reads `CONFLICTING` with `mergeStateStatus` `DIRTY` when the branch conflicts with its base, and in that state the checks may never start. Rebase onto a fresh `origin/main`, push, and return to polling instead of waiting for a run that will never come.

3. Poll the checks as JSON from a script file with an iteration cap: count pending and failed checks with `gh pr checks N --json bucket --jq 'map(select(.bucket == "pending" or .bucket == "fail")) | length'`, and read failures from the same call with `.bucket == "fail"`. Never grep the text output of `gh pr checks`: poll the JSON. Run the loop as one background command so the session can report completion itself, not as a foreground sleep.

4. On a red check, read the failing job with `gh run view <run-id> --log-failed`, fix the cause in the code, and push a fix commit. Never amend or force-push a commit a reviewer may already have read. Every push restarts CI, so return to step 3 afterwards.

5. Read review comments with `gh pr view N --comments` and reply in every thread, either with the fix commit or with the reason the code stands. Never resolve another person's thread, even after fixing it: resolution belongs to the maintainer. Leave the thread open with your reply on it.

6. Merge only when the checks are green, the threads are answered, and the user asked in this request: `gh pr merge N`. Tell the two outcomes apart with `gh pr view N --json state,autoMergeRequest,mergeStateStatus`, and report which one happened: merged now, or auto-merge armed to fire when the checks finish.

7. After `MERGED`, report the merge commit: `gh pr view N --json mergeCommit --jq .mergeCommit.oid`. A merged PR is still not live validation; do not claim the change works on staging or production. Report the PR number, the merge SHA and the merge time, then stop.

## Checks before you merge

- `gh pr checks N --json bucket --jq 'map(select(.bucket == "pending" or .bucket == "fail")) | length'` prints `0`.
- Every review thread has your reply on it, and you resolved none of them.
- The user's message in this request asked for the merge.

## Related skills

- `ship-pr`: takes a change to an opened PR and hands off here.
