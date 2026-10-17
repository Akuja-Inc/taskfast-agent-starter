#!/usr/bin/env node
// Re-captures test/fixtures/cli/surface.json: the raw `--help` text of every taskfast command,
// recursively, which test/cli-parity.test.ts parses offline. Run it by hand when the
// pinned CLI moves; `pnpm check` never runs it.
//
//   node scripts/capture-cli-surface.mjs [path to taskfast]
//
// The child gets only PATH, an empty HOME and an absent config, because help prints the
// value of every env var an option reads (`[env: TASKFAST_API_KEY=...]`).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.argv[2] ?? "taskfast";
const home = mkdtempSync(join(tmpdir(), "taskfast-surface-"));
const env = { PATH: process.env.PATH, HOME: home, COLUMNS: "10000" };
const run = (args) => execFileSync(bin, ["--config", join(home, "absent.json"), "--no-trace", ...args], { env, cwd: home, encoding: "utf8" });

const help = {};
function walk(path) {
  // --help, not -h: short help drops the possible values of an option with only long help.
  const text = run([...path, "--help"]);
  help[path.join(" ")] = text;
  const commands = /\nCommands:\n([\s\S]*?)\n\n/.exec(text)?.[1] ?? "";
  for (const m of commands.matchAll(/^ {2}([a-z][a-z0-9-]*)\s/gm)) if (m[1] !== "help") walk([...path, m[1]]);
}
try {
  const version = run(["--version"]).trim();
  walk([]);
  writeFileSync(join(import.meta.dirname, "..", "test", "fixtures", "cli", "surface.json"), `${JSON.stringify({ version, help }, null, 2)}\n`);
  console.log(`${version}: ${Object.keys(help).length} commands`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
