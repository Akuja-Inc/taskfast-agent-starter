// Runs one turn in the Durable Object, kills workerd, restarts it on the same
// persisted storage and checks the transcript and ledger survived.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const persist = mkdtempSync(join(tmpdir(), "pi-do-"));
const port = 8787 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;

async function withWorker(run) {
  const child = spawn("npx", ["wrangler", "dev", "--port", String(port), "--persist-to", persist], { detached: true, stdio: "ignore" });
  try {
    for (let i = 0; ; i++) {
      try { await fetch(`${base}/`); break; } catch { if (i > 120) throw new Error("wrangler dev did not start"); await new Promise((r) => setTimeout(r, 500)); }
    }
    return await run();
  } finally {
    process.kill(-child.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const get = async (path) => { const res = await fetch(base + path); assert.equal(res.status, 200, await res.clone().text()); return res.json(); };

try {
  const first = await withWorker(async () => {
    const turn = await get("/turn?key=bid:task-1");
    const repeat = await get("/turn?key=bid:task-1");
    return { turn, repeat };
  });
  console.log("before restart:", JSON.stringify(first));
  assert.equal(first.turn.reserved, true);
  assert.equal(first.repeat.reserved, false, "same action key reserved twice");
  assert.deepEqual(first.turn.messages, ["user", "assistant"]);

  const after = await withWorker(() => get("/"));
  console.log("after restart:", JSON.stringify(after));
  assert.deepEqual(after.actions, ["bid:task-1"]);
  assert.deepEqual(after.messages, ["user", "assistant", "user", "assistant"]);
  console.log("ok: Pi storage and the ledger survived a workerd restart");
} finally {
  rmSync(persist, { recursive: true, force: true });
}
