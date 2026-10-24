// Runs inside the CLI Container: POST /run executes one `taskfast` process and
// returns its stdout unchanged. The only route; reachable only through the agent's
// Durable Object binding. Each call gets a fresh folder that is deleted afterwards,
// so no state or secret outlives the call.
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 120_000;

function valid(body) {
  return body && Array.isArray(body.args) && body.args.length <= 64 && body.args.every((arg) => typeof arg === "string" && arg.length <= 8192 && !arg.includes("\0"))
    && typeof body.config === "string" && body.config.length <= 64 * 1024;
}

function run({ args, config }) {
  const home = mkdtempSync(join(tmpdir(), "taskfast-"));
  mkdirSync(join(home, ".taskfast"), { mode: 0o700 });
  const configPath = join(home, ".taskfast", "config.json");
  writeFileSync(configPath, config, { mode: 0o600 });
  return new Promise((resolve) => {
    // The same child environment as src/core/cli.ts: PATH, HOME and TASKFAST_CONFIG only.
    execFile("/usr/local/bin/taskfast", args, { cwd: home, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, TASKFAST_CONFIG: configPath }, timeout: TIMEOUT_MS, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
      rmSync(home, { recursive: true, force: true });
      resolve({ stdout, stderr: stderr.slice(0, 2000), ...(error ? { failure: error.message.slice(0, 500) } : {}) });
    });
  });
}

createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method !== "POST" || req.url !== "/run") return send(404, { error: "not found" });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) return send(413, { error: "too large" }); chunks.push(chunk); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(400, { error: "not JSON" }); }
  if (!valid(body)) return send(400, { error: "args must be strings and config a string" });
  send(200, await run(body));
}).listen(8080);
