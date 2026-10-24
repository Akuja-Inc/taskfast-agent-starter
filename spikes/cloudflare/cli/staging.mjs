// Option A against staging: reads and one no-op write through the image, with
// the agent's .taskfast folder mounted read-only per call. Prints status, timing
// and field names only, never values.
// Usage: node staging.mjs <agent folder>   (stop that agent's host first)
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const folder = resolve(process.argv[2] ?? "");
const IMAGE = "taskfast-cli:0.21.0";
const mount = ["-v", `${folder}/.taskfast:/agent/.taskfast:ro`];

function cli(args, { image = true } = {}) {
  const base = ["--env", "staging", "--config=.taskfast/config.json", "--no-trace", ...args];
  const started = performance.now();
  const result = image
    ? spawnSync("docker", ["run", "--rm", "--read-only", ...mount, IMAGE, ...base], { encoding: "utf8" })
    : spawnSync("taskfast", base, { cwd: folder, env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: "utf8" });
  const ms = Math.round(performance.now() - started);
  const envelope = JSON.parse(result.stdout);
  return { envelope, status: result.status, ms };
}
const keys = (value) => Object.keys(value ?? {}).sort().join(",");

const rows = [];
for (const args of [["ping"], ["me"]]) {
  const host = cli(args, { image: false });
  const image = cli(args);
  assert.equal(image.status, host.status);
  assert.equal(keys(image.envelope.data), keys(host.envelope.data), `${args[0]}: data fields differ`);
  rows.push({ command: args.join(" "), ok: image.envelope.ok, exit: image.status, hostMs: host.ms, imageMs: image.ms, fields: keys(image.envelope.data) });
}
// A real write that changes nothing: set the description to its current value.
const me = cli(["me"]).envelope.data;
const description = me.profile.description;
assert.equal(typeof description, "string", "me has no description to rewrite");
const write = cli(["agent", "update-me", `--description=${description}`]);
rows.push({ command: "agent update-me --description=<current>", ok: write.envelope.ok, exit: write.status, hostMs: "-", imageMs: write.ms, fields: keys(write.envelope.data) });
console.table(rows);
assert.ok(rows.every((row) => row.ok === true && row.exit === 0));
console.log("ok: reads and a no-op write ran on staging through the image");
