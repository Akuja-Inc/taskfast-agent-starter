# Captured taskfast CLI output

Real stdout of the `taskfast` 0.19.0 binary (x86_64 linux release, sha256-checked),
run with `--env local` against a stand-in server on 127.0.0.1:4000 that answered with
the API's documented shapes (for platform config, the bare map the server's
PlatformConfigController returns, with a subset of its keys):

- `task-bids.json`: `taskfast task bids -- <task>`. The server sent `{ data: [bid], meta }`;
  the CLI prints it as `data: { task_id, bids: [...], meta }`.
- `platform-config.json`: `taskfast platform config`. The CLI wraps the server's object
  as `data: { config: {...} }` (taskfast-cli v0.19.0, `crates/taskfast-cli/src/cmd/platform.rs`:
  `json!({ "config": resp })`).

Tests read these files, so the client's parsing is checked against what the CLI
actually prints. Re-capture them when the pinned CLI version changes.

`gh70/` holds the bond captures for issue #70: what `taskfast bond post`, `taskfast task claim`
and `taskfast cast call` print, with the stand-in server, its request logs and the exact
commands. `gh70/README.md` says how to re-capture them.

`skills/taskfast-agent/` is the bundle `taskfast` 0.19.7 writes with `taskfast --config=<empty
dir>/absent.json --no-trace skills --yes`, run in an empty folder that was also its HOME, with
only PATH set. The command wrote identical copies under `.agents/skills/` and
`.claude/skills/`; this is the `.agents` copy, unchanged. `SKILL.md` has SHA-256
`8732dbba4a8bcb781a9055adfab44cd945b3799e51806798b9db0fdcb312b7a7`. Re-capture it the same
way when the CLI changes; the mapping test in `src/core/skills.test.ts` then names any new
command that needs a tool or an explicit "no tool" entry.
