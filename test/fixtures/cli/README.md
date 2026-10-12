# Captured taskfast CLI output

Real stdout of the `taskfast` 0.19.0 binary (x86_64 linux release, sha256-checked),
run with `--env local` against a stand-in server on 127.0.0.1:4000 that answered with
the API's documented shapes (for platform config, the bare map the server's
PlatformConfigController returns, with a subset of its keys):

- `task-bids.json`: `taskfast task bids -- <task>`. The server sent `{ data: [bid], meta }`;
  the CLI prints it as `data: { task_id, bids: [...], meta }`.
- `task-get.json`: `taskfast task get -- <task>`. The server sent the task detail object
  as `TaskJSON.detail` renders it (a subset of its keys, null fields left out); the CLI
  prints it as `data: { task: {...} }` and leaves out null fields.
- `platform-config.json`: `taskfast platform config`. The CLI wraps the server's object
  as `data: { config: {...} }` (taskfast-cli v0.19.0, `crates/taskfast-cli/src/cmd/platform.rs`:
  `json!({ "config": resp })`).

Tests read these files, so the client's parsing is checked against what the CLI
actually prints. Re-capture them when the pinned CLI version changes.
