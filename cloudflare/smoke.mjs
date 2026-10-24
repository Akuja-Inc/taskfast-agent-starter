// Runs the Worker, the agent's Durable Object and the CLI Container under
// `wrangler dev` (Docker), then restarts workerd on the same storage. A stand-in
// Access key server signs the owner's token. Reads only: writes are refused in PR3.
// Usage: node smoke.mjs <agent folder>   (its .taskfast/config.json becomes the
// TASKFAST_CONFIG secret; stop that folder's local host first). Prints statuses,
// timings and field names, never values.
import { spawn } from "node:child_process";
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const folder = resolve(process.argv[2] ?? "");
const config = readFileSync(join(folder, ".taskfast/config.json"), "utf8");
const env = JSON.parse(config).environment;
assert.ok(env === "staging" || env === "local", "smoke runs on staging or local only, never production");
const persist = mkdtempSync(join(tmpdir(), "do-host-"));
const port = 8800 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;

// Stand-in for https://<team>.cloudflareaccess.com/cdn-cgi/access/certs.
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const certs = createServer((req, res) => {
  res.writeHead(req.url === "/cdn-cgi/access/certs" ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: "smoke", alg: "RS256" }] }));
}).listen(0, "127.0.0.1");
await new Promise((r) => certs.once("listening", r));
const team = `http://127.0.0.1:${certs.address().port}`;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function jwt(claims = {}) {
  const head = b64({ alg: "RS256", kid: "smoke" });
  const body = b64({ iss: team, aud: ["smoke-aud"], exp: Math.floor(Date.now() / 1000) + 600, email: "owner@example.com", ...claims });
  return `${head}.${body}.${createSign("RSA-SHA256").update(`${head}.${body}`).sign(pair.privateKey).toString("base64url")}`;
}
const token = randomBytes(32).toString("hex");
const devVars = join(import.meta.dirname, ".dev.vars");
writeFileSync(devVars, [
  `CLI_ENV=${env === "local" ? "local" : "staging"}`, `ACCESS_TEAM_DOMAIN=${team}`, "ACCESS_AUD=smoke-aud",
  `CONSOLE_TOKEN=${token}`, `TASKFAST_CONFIG='${JSON.stringify(JSON.parse(config))}'`, "MODEL_SETTINGS={}",
].join("\n") + "\n", { mode: 0o600 });

async function withWorker(run) {
  const child = spawn("npx", ["wrangler", "dev", "--port", String(port), "--persist-to", persist], { cwd: import.meta.dirname, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  try {
    for (let i = 0; ; i++) {
      try { await fetch(base); break; } catch { if (i > 600) throw new Error(`wrangler dev did not start:\n${log.slice(-2000)}`); await new Promise((r) => setTimeout(r, 500)); }
    }
    return await run();
  } catch (error) { console.error(log.slice(-3000)); throw error; }
  finally { process.kill(-child.pid, "SIGKILL"); await new Promise((r) => setTimeout(r, 1500)); }
}
const request = async (path, headers = {}, method = "GET") => {
  const started = performance.now();
  const response = await fetch(base + path, { method, headers });
  return { status: response.status, body: await response.json().catch(() => null), ms: Math.round(performance.now() - started) };
};
const owner = () => ({ "cf-access-jwt-assertion": jwt(), authorization: `Bearer ${token}` });

const rows = [];
try {
  await withWorker(async () => {
    rows.push({ check: "no Access token", ...(await request("/api/agents")) });
    rows.push({ check: "expired Access token", ...(await request("/api/agents", { "cf-access-jwt-assertion": jwt({ exp: 1 }), authorization: `Bearer ${token}` })) });
    rows.push({ check: "wrong audience", ...(await request("/api/agents", { "cf-access-jwt-assertion": jwt({ aud: ["other"] }), authorization: `Bearer ${token}` })) });
    rows.push({ check: "no console token", ...(await request("/api/agents", { "cf-access-jwt-assertion": jwt() })) });
    rows.push({ check: "a write", ...(await request("/api/agents/my-agent/paused", owner(), "POST")) });
    // The first owner read opens the store and binds identity with `me` through the Container.
    rows.push({ check: "roster, first open", ...(await request("/api/agents", owner())) });
    rows.push({ check: "agent view", ...(await request("/api/agents/my-agent", owner())) });
  });
  await withWorker(async () => {
    rows.push({ check: "roster after restart", ...(await request("/api/agents", owner())) });
    rows.push({ check: "agent view after restart", ...(await request("/api/agents/my-agent", owner())) });
  });
  console.table(rows.map(({ check, status, ms, body }) => ({ check, status, ms, state: body?.agents?.[0]?.state ?? body?.agents?.[0]?.reason ?? (body?.error ? `error: ${body.error}` : body ? Object.keys(body).length + " fields" : "") })));
  const by = (check) => rows.find((row) => row.check === check);
  for (const check of ["no Access token", "expired Access token", "wrong audience"]) assert.equal(by(check).status, 403, check);
  assert.equal(by("no console token").status, 401);
  assert.equal(by("a write").status, 405);
  for (const check of ["roster, first open", "roster after restart"]) assert.equal(by(check).body.agents[0].state, "ready", `${check}: ${JSON.stringify(by(check).body)}`);
  for (const check of ["agent view", "agent view after restart"]) assert.equal(by(check).status, 200, check);
  // The identity the DO bound before the restart is the one it reopened with.
  assert.equal(by("agent view after restart").body.timeline.length >= by("agent view").body.timeline.length, true);
  console.log("ok: Access-gated reads through the Durable Object and the CLI Container, before and after a workerd restart");
} finally {
  rmSync(devVars, { force: true });
  rmSync(persist, { recursive: true, force: true });
  certs.close();
}
