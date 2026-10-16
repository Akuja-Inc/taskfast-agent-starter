# Plan: let a worker deliver file artifacts (#71)

Status: the two open choices below went to the owner in the Plannotator Inbox; this PR implements the recommended answer to each and changes if the owner picks otherwise.
Source: [issue #71](https://github.com/Akuja-Inc/taskfast-agent-starter/issues/71), `Refs #64`.

## Outcome

A worker can deliver a task whose acceptance needs files. The model writes each file's text into its `task_submit` or `task_remedy` call. Code writes the file inside the agent folder, and the CLI uploads it and submits. No path, flag or binary content comes from the model.

## What the captures show

Twelve captures of the real `taskfast` 0.19.7 binary against `test/fixtures/cli/gh71/stand-in-server.py`, which answers the shapes `test/fixtures/openapi.yaml` documents. No marketplace account was touched. `test/fixtures/cli/gh71/README.md` lists them.

1. `task submit --artifact=a --artifact=b` uploads each file in order (`POST /tasks/{id}/artifacts`, multipart, filename = the file's basename), then submits with exactly the returned `artifact_ids`. The content type comes from the extension: `.json` is `application/json`, `.csv` is `text/csv`, `.html` is `text/html`, `.xml` is `application/xml`, `.css` is `text/css`, `.js` is `application/javascript`, `.md` and `.txt` are `text/plain`. Each is on the server's documented upload list.
2. The trap: when the second upload is refused, the first has already landed, yet the CLI prints `error.code = "validation"`. A 422 (criteria not met) and a 409 at the submit step print `validation` too, after every upload landed. `validation` is in `REFUSED`, so today's policy would record `failed` and permit a retry that uploads the same files again.
3. A file that does not exist is refused as `usage` before any request.
4. `artifact list` returns `data.artifacts[]` with `id`, `filename`, `size_bytes`, `uploaded_by_id` and `created_at`, and `[]` on a task with no uploads. `--limit=100`, the spec's maximum, reaches the server as `?limit=100`. `artifact delete` returns `data.deleted = true`.
5. `task remedy` behaves like submit: uploads, then `POST /tasks/{id}/remedy` with the new `artifact_ids`; `max_remedies_reached` prints `validation`.

From the spec, not the captures: a submit whose criteria fail leaves the task `in_progress` so the worker can fix and resubmit; criteria match artifacts by filename (`target_artifact_pattern`, `file_exists`); delete is refused once the task is under review.

## Decisions

**D1. Content is the model's text.** `task_submit` gains an optional `artifacts` list and the new `task_remedy` takes one. Each entry is `{ name, content }`. At most 5 per call, each 1 byte to 256 KiB of UTF-8, names unique. The model has no file system, so text is the only source; a task that needs a PDF, an image or an archive stays out of reach.

**D2. The model names the file; code builds the path.** A criterion can require `results.json`, so a kit-chosen name would fail real tasks. The name must match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}\.(txt|md|csv|json|xml|html|css|js)$`: one basename, no separator, no leading dot or dash, an extension the server accepts as text. Code places it at `.pi-state/artifacts/<task_id>/<sha256 of content, 16 hex>/<name>`, checks it with `folderFile`, and passes `--artifact=<path>` as an option before `--`. The same posture as `word` for flag values: a checked value inside a kit-built option.

**D3. Code writes the files before it reserves the action.** The path is content-addressed, so writing the same file twice is harmless. A write that fails refuses the call before anything is reserved or dispatched. Directories are 0700 and files 0600, like the store.

**D4. A failed submit stays retryable.** Bond-style `uncertain` would block delivery after one failed evaluation, and the spec says the worker resubmits after a 422. Keep the CLI's `failed`.

**D5. Code clears this agent's stale uploads before an artifact-bearing submit.** On an `in_progress` task the kit has no other upload path, so every artifact with `uploaded_by_id` equal to this agent came from an earlier submit that failed. Before dispatch, code runs `artifact list -- <task>` and `artifact delete -- <task> <id>` for each one. Any non-ok result refuses the submit before reservation, and the next attempt lists again. The duplicates are clutter rather than money (the submit names its own `artifact_ids`), but this keeps them from piling up across resubmits. Open choice Q1.

**D6. `task_remedy` is keyed by its content.** `remedy:<task_id>:<digest of summary and artifacts>`, like `message_send`. The server allows three remedies, so a changed remedy is a new action, an identical failed one may retry and an uncertain one never repeats. Remedy gets no stale-upload gate: on a disputed task the original deliverables are also this agent's uploads, likely share the criterion's filename, and may not be deletable. A refused remedy leaves its uploads behind, unevaluated. Open choice Q2.

**D7. Uncertain uploads never repeat.** The existing rule covers them: an `uncertain` submit or remedy is never dispatched again.

**D8. Stored calls stay valid.** `task_submit` keeps `required: [task_id, summary]` and its key `submit:<task_id>`; `artifacts` is optional, so a stored summary-only call still validates on recovery.

**D9. No standalone artifact tools.** `task submit --artifact` folds upload into submit, so `artifact upload|list|delete` stay unsupported as model tools. The list and delete in D5 run as code.

## Open choices for the owner

- **Q1.** Who clears stale uploads before a resubmit? (a) Code lists and deletes them as part of the submit (recommended: fewest tools, no extra model turn). (b) Code refuses the submit and names them, and the model deletes each with a new `artifact_delete` write tool keyed per artifact.
- **Q2.** Ship `task_remedy` now without a stale-upload gate (recommended; the ceiling is clutter, never evaluation), or hold remedy until the server marks which artifacts a submission used.

## Validation

- `pnpm check`.
- `test/cli-captures.test.ts` reads the gh71 envelopes, so a change in the CLI's shapes fails there first.
- Policy tests on a real SQLite store with a fake CLI: files land at the expected folder paths; a failed submit's uploads are deleted before the resubmit; a failed delete refuses the resubmit without reserving; a remedy with new content runs again and an uncertain one does not; a stored summary-only `task_submit` still validates.
- No live run. A staging submit needs an assigned task and the owner's permission.
