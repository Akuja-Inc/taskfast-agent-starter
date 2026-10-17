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

`gh71/` holds the artifact captures for issue #71: what `taskfast task submit --artifact`,
`task remedy --artifact` and `taskfast artifact list|delete` print, with the stand-in server,
its request logs and the exact commands. `gh71/README.md` says how to re-capture them.

`surface.json` is the `--help` text of every `taskfast` 0.19.8 command, by command path (`""` is the root), with `taskfast --version`. `node scripts/capture-cli-surface.mjs [path to taskfast]` writes it, running each command with only PATH, an empty HOME and an absent config, because help prints the value of every env var an option reads. It uses `--help`, not `-h`: short help drops the possible values of an option that has only long help, such as `discover --status`. `test/cli-parity.test.ts` (in `pnpm test`) parses it offline and fails when a tool passes a flag or value the CLI refuses, or when a command has neither a tool nor a reason in `EXCLUDED` (`test/cli-parity.ts`). Re-capture it whenever the contract test's pinned CLI tag moves.

`skills/taskfast-agent/` is the bundle `taskfast` 0.19.7 writes (0.19.8 writes it unchanged) with `taskfast --config=<empty
dir>/absent.json --no-trace skills --yes`, run in an empty folder that was also its HOME, with
only PATH set. The command wrote identical copies under `.agents/skills/` and
`.claude/skills/`; this is the `.agents` copy, unchanged. `SKILL.md` has SHA-256
`8732dbba4a8bcb781a9055adfab44cd945b3799e51806798b9db0fdcb312b7a7`. Re-capture it the same
way when the CLI changes; the mapping test in `src/core/skills.test.ts` then names any new
command that needs a tool or an explicit "no tool" entry.
