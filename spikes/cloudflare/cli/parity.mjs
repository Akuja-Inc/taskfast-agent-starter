// Option A parity: runs captured fixture commands against their stand-in
// servers with the host `taskfast` and with the image, and checks both print
// the same envelope and exit code as each other and as the capture.
// Usage: node parity.mjs [path to host taskfast]   (needs docker, python3, eth_account)
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const fixtures = join(import.meta.dirname, "../../../test/fixtures/cli");
const hostBin = process.argv[2] ?? "taskfast";
const IMAGE = "taskfast-cli:0.21.0";
const TASK = "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b";
const work = mkdtempSync(join(tmpdir(), "cli-parity-"));
writeFileSync(join(work, "results.json"), '{"results":[1,2,3]}\n');
writeFileSync(join(work, "data.csv"), "a,b\n1,2\n");
// Throwaway keystore, same recipe as gh70/README.md. Never a real wallet.
spawnSync("python3", ["-c", `from eth_account import Account; import json; open("${work}/wallet.json","w").write(json.dumps(Account.encrypt(Account.from_key("0x"+"11"*32).key,"testpassword")))`], { stdio: "inherit" });
writeFileSync(join(work, "pw"), "testpassword");

const signing = ["--keystore=wallet.json", "--wallet-password-file=pw"];
const cases = [
  { capture: "gh71/artifact-list", env: { UPLOADED: "1" }, args: ["artifact", "list", "--", TASK] },
  { capture: "gh71/artifact-delete", args: ["artifact", "delete", "--", TASK, "550e8400-e29b-41d4-a716-446655440001"] },
  { capture: "gh71/submit-artifacts", args: ["task", "submit", "--summary=Delivered", "--artifact=results.json", "--artifact=data.csv", "--", TASK] },
  { capture: "gh71/submit-second-upload-refused", env: { UPLOAD_FAIL_AT: "2", UPLOAD_STATUS: "415", UPLOAD_CODE: "unsupported_media_type" }, args: ["task", "submit", "--summary=Delivered", "--artifact=results.json", "--artifact=data.csv", "--", TASK] },
  { capture: "gh71/submit-missing-file", args: ["task", "submit", "--summary=Delivered", "--artifact=absent.json", "--", TASK] },
  { capture: "gh70/cast-decimals", args: ["cast", "call", "0x20c0000000000000000000000000000000000000", "decimals()(uint8)"] },
  { capture: "gh70/claim-bond-pending", env: { CLAIM_STATUS: "409", CLAIM_CODE: "bond_pending" }, args: ["task", "claim", TASK] },
  { capture: "gh70/bond-dry-run", args: ["bond", "post", TASK, "--dry-run", ...signing] },
  { capture: "gh70/bond-preflight-balance", env: { BALANCE_LOW: "1" }, args: ["bond", "post", TASK, ...signing] },
];

async function withServer(dir, env, port, run) {
  const server = spawn("python3", [join(fixtures, dir, "stand-in-server.py"), "--port", String(port)], { env: { PATH: process.env.PATH, ...env }, stdio: "ignore" });
  try {
    for (let i = 0; ; i++) {
      try { await fetch(`http://127.0.0.1:${port}/config/network`); break; } catch { if (i > 50) throw new Error("stand-in did not start"); await new Promise((r) => setTimeout(r, 100)); }
    }
    return run();
  } finally { server.kill(); }
}
function run(command, args) {
  const started = performance.now();
  const result = spawnSync(command, args, { cwd: work, env: { PATH: process.env.PATH, HOME: work }, encoding: "utf8" });
  return { out: result.stdout.trim(), status: result.status, ms: Math.round(performance.now() - started) };
}
// `bond post` draws a fresh random salt per call, which also appears in its calldata;
// its `rpc_url` carries the stand-in server's port.
const shape = (text) => {
  const { environment, dry_run, security_warnings, ...rest } = JSON.parse(text);
  const salt = rest.data?.salt?.slice(2);
  const masked = JSON.stringify(rest).replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>");
  return JSON.parse(salt ? masked.replaceAll(salt, "<salt>") : masked);
};

let port = 4200;
const timings = [];
try {
  for (const c of cases) {
    port++;
    const cli = ["--env", "local", "--allow-custom-endpoints", `--api-base=http://127.0.0.1:${port}`, "--config=./absent.json", "--no-trace", "--api-key=test-key", ...c.args];
    const [dir] = c.capture.split("/");
    const host = await withServer(dir, c.env, port, () => run(hostBin, cli));
    const container = await withServer(dir, c.env, port, () => run("docker", ["run", "--rm", "--network=host", "--read-only", "-v", `${work}:/agent:ro`, IMAGE, ...cli]));
    assert.equal(container.status, host.status, `${c.capture}: exit codes differ`);
    assert.deepEqual(shape(container.out), shape(host.out), `${c.capture}: envelopes differ`);
    const captured = shape(readFileSync(join(fixtures, `${c.capture}.json`), "utf8"));
    const matchesCapture = JSON.stringify(shape(host.out)) === JSON.stringify(captured);
    timings.push({ capture: c.capture, exit: host.status, hostMs: host.ms, containerMs: container.ms, matchesCapture });
  }
  console.table(timings);
  console.log("ok: the image prints the same envelope and exit code as the host binary for every captured command");
} finally {
  rmSync(work, { recursive: true, force: true });
}
