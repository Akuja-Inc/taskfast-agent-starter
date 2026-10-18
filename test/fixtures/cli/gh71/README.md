# Captured artifact output (gh#71)

Real stdout of the `taskfast` 0.20.1 binary (the version this kit pins), run with
`--env local` against `stand-in-server.py` in this folder. The server answers the shapes
`test/fixtures/openapi.yaml` documents, so nothing here touches a marketplace account.

Every `<name>.json` is the CLI's own envelope, unchanged. Every `<name>.requests.log` is
what the stand-in server received during that command; for an upload it records the
multipart part's filename, content type and size. That is how a capture shows which
uploads landed before a refusal.

Since 0.20.0 (taskfast-cli#193) each upload first asks `POST /tasks/{id}/artifacts/uploads`
for a presigned PUT. The stand-in answers 404, so under `--env local` the CLI falls back to
the multipart POST, and each upload logs both requests. On staging and production the CLI
puts the bytes straight to R2 and never falls back; these captures do not exercise that
path.

| Capture | Command | Exit | What it shows |
|---|---|---|---|
| `submit-artifacts` | `task submit --summary=Delivered --artifact=results.json --artifact=data.csv` | 0 | Uploads each file in order, filename = the file's basename, then submits exactly the returned `artifact_ids`. `data.artifacts[]` and `data.submission` are the envelope. |
| `submit-second-upload-refused` | the same, server refuses the 2nd upload with 415 | 7 | The trap: `error.code = "validation"` although the request log shows the first upload landed. |
| `submit-criteria-failed` | `task submit ... --artifact=results.json`, submit answers 422 | 7 | `validation` after the upload and the submit both reached the server. The spec says the task stays `in_progress` for a resubmit. |
| `submit-not-eligible` | the same, submit answers 409 `task_not_eligible` | 7 | `validation` after the upload landed. |
| `submit-missing-file` | `task submit ... --artifact=absent.json` | 2 | `usage` before any request: the request log is empty. |
| `content-types` | `task submit ... --artifact=report.txt --artifact=notes.md --artifact=page.html` | 0 | The CLI picks the content type from the extension: `.txt` and `.md` are `text/plain`, `.html` is `text/html`. |
| `content-types-code` | `task submit ... --artifact=data.xml --artifact=style.css --artifact=app.js` | 0 | `.xml` is `application/xml`, `.css` is `text/css`, `.js` is `application/javascript`: each on the server's documented list. |
| `artifact-list` | `artifact list -- <task>`, one upload on the task | 0 | `data.artifacts[]` with `id`, `filename`, `size_bytes`, `uploaded_by_id`, `created_at`. |
| `artifact-list-empty` | `artifact list --limit=100 -- <task>`, no uploads | 0 | `data.artifacts` is `[]`, not missing; the request carries `?limit=100`, the spec's maximum. |
| `artifact-delete` | `artifact delete -- <task> <artifact>` | 0 | `data.deleted = true` after a 204. |
| `remedy-artifacts` | `task remedy --summary=Revised --artifact=results.json` | 0 | Uploads, then `POST /tasks/{id}/remedy` with the new `artifact_ids`. |
| `remedy-not-eligible` | the same, remedy answers 409 `max_remedies_reached` | 7 | `validation` after the upload landed. |

What the stand-in cannot prove: how the live server treats a delete on a disputed task,
whether it accepts uploads under review, and its real content-type checks. The spec says
delete is refused once a task is under review.

## Re-capturing

The stand-in server needs only Python 3. Scenarios come from environment variables
(`UPLOAD_FAIL_AT`, `UPLOAD_STATUS`, `UPLOAD_CODE`, `SUBMIT_STATUS`, `SUBMIT_CODE`,
`UPLOADED`; the script's docstring lists them), so one capture is one server start:

```bash
UPLOAD_FAIL_AT=2 python3 test/fixtures/cli/gh71/stand-in-server.py --port 4124 &
```

Then, from a folder holding the sample files (`results.json` was `{"results":[1,2,3]}`
and a newline, `data.csv` was `a,b`, `1,2`), with only `PATH` and `HOME` set:

```bash
taskfast --env local --allow-custom-endpoints --api-base=http://127.0.0.1:4124 \
  --config=./absent.json --no-trace --api-key=test-key \
  task submit --summary=Delivered --artifact=results.json --artifact=data.csv \
  -- 4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b
```

No keystore is needed: none of these commands signs. `test/cli-captures.test.ts` reads
`artifact-list.json`, `artifact-list-empty.json` and `submit-second-upload-refused.json`,
so a change in any of those shapes fails there first. Never
edit a capture to make a test pass: re-capture it.
