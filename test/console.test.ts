import { request } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { startConsole, type ConsoleAgent } from "../src/console.js";
import { initialOperator, type OperatorState } from "../src/core/operator.js";
import { parseAgentSpec } from "../src/core/spec.js";

const token = "a".repeat(64);
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

// One agent whose controls record what the console asked of them.
function fakeAgent(id = "foo") {
  const asked: unknown[][] = [];
  const state: OperatorState = initialOperator();
  const record = (name: string) => async (...args: unknown[]) => { asked.push([name, ...args]); };
  const agent: ConsoleAgent = {
    id,
    spec: parseAgentSpec(JSON.parse(readFileSync(new URL("../examples/brisk-poster.json", import.meta.url), "utf8"))),
    agent: {
      status: async () => ({ identity: { env: "local", agentId: "33333333-3333-4333-8333-333333333333" }, actions: {}, spend: {}, memory: [] }),
      transcript: async () => [],
      operator: {
        state: async () => state, events: async () => ({}),
        setFrozen: record("setFrozen"), setPaused: record("setPaused"), message: record("message"),
        addOrder: record("addOrder"), removeOrder: record("removeOrder"), markChecked: record("markChecked"), retryEvent: record("retryEvent"),
      },
    },
  };
  return { agent, asked };
}
async function serve(agents = [fakeAgent().agent]) {
  const consoleServer = await startConsole({ port: 0, token, env: "local", agents: () => agents });
  closers.push(consoleServer.close);
  return consoleServer;
}
function call(port: number, path: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => { text += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}
const auth = { authorization: `Bearer ${token}` };

it("only answers this machine's own pages, and only with the token", async () => {
  const { port, url } = await serve();
  expect(url).toBe(`http://127.0.0.1:${port}/#token=${token}`);

  const page = await call(port, "/");
  expect(page.status).toBe(200);
  expect(page.text).toContain("<html");
  expect(page.text).not.toContain(token);

  expect((await call(port, "/api/agents")).status).toBe(401);
  expect((await call(port, "/api/agents", { headers: { authorization: `Bearer ${"b".repeat(64)}` } })).status).toBe(401);
  expect((await call(port, "/api/agents", { headers: { ...auth, host: `rebound.example:${port}` } })).status).toBe(403);
  expect((await call(port, "/api/agents/foo/pause", { method: "POST", headers: { ...auth, origin: "https://elsewhere.example" } })).status).toBe(403);
  expect((await call(port, "/api/agents", { method: "OPTIONS", headers: { origin: "https://elsewhere.example" } })).status).toBe(405);

  const allowed = await call(port, "/api/agents", { headers: { ...auth, host: `localhost:${port}` } });
  expect(allowed.status).toBe(200);
  expect(JSON.parse(allowed.text)).toMatchObject({ env: "local", agents: [{ id: "foo" }] });
  expect(Object.keys(allowed.headers).filter((name) => name.startsWith("access-control-"))).toEqual([]);
});
