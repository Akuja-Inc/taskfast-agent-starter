// One signed staging write through the Container's server image, sent the way the
// DO sends it: `post` gets the keystore and password in the call body, `task cancel`
// gets neither. The task is a direct one to a second agent of the owner's, so no
// stranger bids. Prints statuses, timings and field names, never values.
// Usage: docker build -t taskfast-cli-server cli && npx tsc -p ../tsconfig.build.json &&
//        node cli/staging-write.mjs <poster folder> <worker folder>   (stop both hosts first)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { TOOLS } from "../../dist/src/core/tools.js";
import { signs } from "../../dist/src/core/cli.js";

const [poster, worker] = process.argv.slice(2).map((path) => resolve(path));
const read = (folder, file) => readFileSync(join(folder, ".taskfast", file), "utf8");
const config = read(poster, "config.json");
assert.equal(JSON.parse(config).environment, "staging", "staging only");
const workerId = JSON.parse(read(worker, "config.json")).agent_id;
const wallet = { keystore: read(poster, "wallet.json"), password: read(poster, "wallet-password") };
const PORT = 18182;
const name = `cli-staging-${process.pid}`;
spawnSync("docker", ["run", "-d", "--rm", "--name", name, "--network=host", "-e", `PORT=${PORT}`, "--read-only", "--tmpfs", "/tmp", "taskfast-cli-server"]);
const base = `http://127.0.0.1:${PORT}`;
async function run(args) {
  const body = { args: ["--env", "staging", ...args], config, ...(signs(args) ? wallet : {}) };
  const started = performance.now();
  const reply = await (await fetch(`${base}/run`, { method: "POST", body: JSON.stringify(body) })).json();
  return { envelope: JSON.parse(reply.stdout), ms: Math.round(performance.now() - started), wallet: "keystore" in body };
}
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { if (i > 50) throw new Error("server did not start"); await new Promise((r) => setTimeout(r, 200)); }
  }
  const post = await run(TOOLS.post_task.args({ title: "Cloudflare host check (cancel me)", description: "A #144 check of the Cloudflare host's CLI path. It is cancelled right away.", budget: "1.00", pickup_deadline_hours: 1, assignment_type: "direct", direct_agent_id: workerId }));
  assert.equal(post.envelope.ok, true, JSON.stringify(post.envelope.error));
  const taskId = post.envelope.data.task_id ?? post.envelope.data.task?.id ?? post.envelope.data.id;
  assert.equal(typeof taskId, "string", `post data fields: ${Object.keys(post.envelope.data)}`);
  const cancel = await run(TOOLS.task_cancel.args({ task_id: taskId }));
  console.table([
    { command: "post (direct, budget 1.00)", ok: post.envelope.ok, wallet: post.wallet, ms: post.ms, fields: Object.keys(post.envelope.data).sort().join(",") },
    { command: "task cancel", ok: cancel.envelope.ok, wallet: cancel.wallet, ms: cancel.ms, ...(cancel.envelope.ok ? { fields: Object.keys(cancel.envelope.data ?? {}).sort().join(",") } : { error: cancel.envelope.error?.code }) },
  ]);
  assert.equal(cancel.envelope.ok, true, JSON.stringify(cancel.envelope.error));
  console.log("ok: a signed staging post and its cancel ran through the server image");
} finally {
  spawnSync("docker", ["rm", "-f", name]);
}
