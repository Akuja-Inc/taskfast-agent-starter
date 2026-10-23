// Runs inside the CLI Container. GET /health answers once the server listens;
// POST /run executes one `taskfast` process and returns its stdout unchanged.
// Reachable only through the agent's Durable Object binding. Each call gets a fresh
// folder that is deleted afterwards, so no state or secret outlives the call.
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 120_000;
const text = (value, max) => typeof value === "string" && value.length <= max;

function valid(body) {
  return body && Array.isArray(body.args) && body.args.length <= 64 && body.args.every((arg) => text(arg, 8192) && !arg.includes("\0"))
    && text(body.config, 64 * 1024)
    && (body.keystore === undefined) === (body.password === undefined)
    && (body.keystore === undefined || (text(body.keystore, 64 * 1024) && text(body.password, 4096)));
}

function run({ args, config, keystore, password }) {
  const home = mkdtempSync(join(tmpdir(), "taskfast-"));
  const dir = join(home, ".taskfast");
  mkdirSync(dir, { mode: 0o700 });
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, config, { mode: 0o600 });
  let argv = args;
  if (keystore !== undefined) {
    // The kit's layout: keystore_path is .taskfast/wallet.json, relative to the folder.
    writeFileSync(join(dir, "wallet.json"), keystore, { mode: 0o600 });
    const passwordFile = join(dir, "wallet-password");
    writeFileSync(passwordFile, password, { mode: 0o400 });
    // As src/core/cli.ts does it: one option before the positional delimiter.
    const delimiter = args.indexOf("--");
    const at = delimiter < 0 ? args.length : delimiter;
    argv = [...args.slice(0, at), `--wallet-password-file=${passwordFile}`, ...args.slice(at)];
  }
  return new Promise((resolve) => {
    // The same child environment as src/core/cli.ts: PATH, HOME and TASKFAST_CONFIG only.
    execFile("/usr/local/bin/taskfast", argv, { cwd: home, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, TASKFAST_CONFIG: configPath }, timeout: TIMEOUT_MS, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
      rmSync(home, { recursive: true, force: true });
      resolve({ stdout, stderr: stderr.slice(0, 2000), ...(error ? { failure: error.message.slice(0, 500) } : {}) });
    });
  });
}

createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
  if (req.method !== "POST" || req.url !== "/run") return send(404, { error: "not found" });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) return send(413, { error: "too large" }); chunks.push(chunk); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(400, { error: "not JSON" }); }
  if (!valid(body)) return send(400, { error: "args must be strings, config a string, and keystore and password both or neither" });
  send(200, await run(body));
  // 8080 is the Container class's defaultPort; PORT is only for running the image on a host network.
}).listen(Number(process.env.PORT ?? 8080));
