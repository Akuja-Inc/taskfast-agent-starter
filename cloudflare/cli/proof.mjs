// Drives the Container's server image the way the DO does, without Cloudflare:
// health, a read with no wallet, and `bond post --dry-run`, which decrypts a
// throwaway keystore sent per call (gh70 recipe), against the gh70 stand-in; and a
// submit whose artifact travels in the call body, against the gh71 stand-in.
// Usage: docker build -t taskfast-cli-server cli && node cli/proof.mjs  (needs python3, eth_account)
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import assert from "node:assert/strict";

const IMAGE = "taskfast-cli-server";
const TASK = "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b";
const fixtures = join(import.meta.dirname, "../../test/fixtures/cli");
const keystore = spawnSync("python3", ["-c", 'from eth_account import Account; import json; print(json.dumps(Account.encrypt(Account.from_key("0x"+"11"*32).key,"testpassword")))'], { encoding: "utf8" }).stdout.trim();
const standIn = spawn("python3", [join(fixtures, "gh70/stand-in-server.py"), "--port", "4321"], { stdio: "ignore" });
const uploads = spawn("python3", [join(fixtures, "gh71/stand-in-server.py"), "--port", "4322"], { stdio: ["ignore", "pipe", "ignore"] });
let uploadLog = "";
uploads.stdout.on("data", (chunk) => { uploadLog += chunk; });
const PORT = 18181;
const name = `cli-proof-${process.pid}`;
spawnSync("docker", ["run", "-d", "--rm", "--name", name, "--network=host", "-e", `PORT=${PORT}`, "--read-only", "--tmpfs", "/tmp", IMAGE]);
const base = `http://127.0.0.1:${PORT}`;
const config = JSON.stringify({ environment: "local", api_key: "test-key", keystore_path: ".taskfast/wallet.json" });
const cli = ["--env", "local", "--allow-custom-endpoints", "--api-base=http://127.0.0.1:4321", "--no-trace"];
const run = async (body) => {
  const started = performance.now();
  const reply = await (await fetch(`${base}/run`, { method: "POST", body: JSON.stringify(body) })).json();
  return { ...reply, ms: Math.round(performance.now() - started), envelope: JSON.parse(reply.stdout) };
};
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { if (i > 50) throw new Error("server did not start"); await new Promise((r) => setTimeout(r, 200)); }
  }
  const read = await run({ args: [...cli, "cast", "call", "0x20c0000000000000000000000000000000000000", "decimals()(uint8)"], config });
  assert.equal(read.envelope.ok, true, read.stdout + read.stderr);
  assert.equal(read.envelope.data.decoded[0], "6");
  const dry = await run({ args: [...cli, "bond", "post", "--dry-run", "--", TASK], config, keystore, password: "testpassword" });
  assert.equal(dry.envelope.ok, true, dry.stdout);
  assert.equal(dry.envelope.data.action, "would_post_bond");
  const wrong = await run({ args: [...cli, "bond", "post", "--dry-run", "--", TASK], config, keystore, password: "not it" });
  assert.equal(wrong.envelope.ok, false);
  const ARTIFACT = `.pi-state/artifacts/${TASK}/abc123/results.json`;
  const submit = await run({
    args: ["--env", "local", "--allow-custom-endpoints", "--api-base=http://127.0.0.1:4322", "--no-trace", "--api-key=test-key", "task", "submit", "--summary=Delivered", `--artifact=${ARTIFACT}`, "--", TASK],
    config, files: [{ path: ARTIFACT, base64: Buffer.from('{"results":[1,2,3]}\n').toString("base64") }],
  });
  assert.equal(submit.envelope.ok, true, submit.stdout + submit.stderr);
  // The stand-in logged the multipart part: the file's basename and its 20 bytes.
  assert.match(uploadLog, /results\.json/);
  const traversal = await fetch(`${base}/run`, { method: "POST", body: JSON.stringify({ args: ["me"], config, files: [{ path: ".pi-state/artifacts/../../x", base64: "" }] }) });
  assert.equal(traversal.status, 400);
  const half = await fetch(`${base}/run`, { method: "POST", body: JSON.stringify({ args: ["me"], config, keystore }) });
  assert.equal(half.status, 400);
  // Nothing outlives a call: the per-call folders are gone.
  const left = spawnSync("docker", ["exec", name, "sh", "-c", "ls -A /tmp"], { encoding: "utf8" }).stdout.trim();
  assert.equal(left, "");
  console.table([
    { call: "cast call (no wallet)", ok: read.envelope.ok, ms: read.ms },
    { call: "bond post --dry-run (wallet sent)", ok: dry.envelope.ok, ms: dry.ms, action: dry.envelope.data.action },
    { call: "bond post --dry-run (wrong password)", ok: wrong.envelope.ok, ms: wrong.ms, code: wrong.envelope.error?.code },
    { call: "keystore without password", status: half.status },
    { call: "task submit with an artifact in the body", ok: submit.envelope.ok, ms: submit.ms },
    { call: "artifact path with ..", status: traversal.status },
  ]);
  console.log("ok: the server image decrypts a keystore sent per call, uploads an artifact sent per call, refuses a half wallet and a traversal, and leaves nothing behind");
} finally {
  spawnSync("docker", ["rm", "-f", name]);
  standIn.kill();
  uploads.kill();
}
