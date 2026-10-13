import { createServer, request } from "node:http";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { startConsole, type ConsoleAgent } from "../src/console.js";
import { initialOperator, type OperatorState } from "../src/core/operator.js";
import { parseAgentSpec } from "../src/core/spec.js";

const token = "a".repeat(64);
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

// One agent whose controls record what the console asked of them.
type Ledger = Awaited<ReturnType<ConsoleAgent["agent"]["status"]>>;
type Work = Awaited<ReturnType<ConsoleAgent["agent"]["operator"]["events"]>>;
function fakeAgent({ id = "foo", actions = {}, events = {}, transcript = [], state = initialOperator() }: { id?: string; actions?: Ledger["actions"]; events?: Work; transcript?: Message[]; state?: OperatorState } = {}) {
  const asked: unknown[][] = [];
  const record = (name: string) => async (...args: unknown[]) => { asked.push([name, ...args]); };
  const agent: ConsoleAgent = {
    id,
    spec: parseAgentSpec(JSON.parse(readFileSync(new URL("../examples/brisk-poster.json", import.meta.url), "utf8"))),
    agent: {
      status: async () => ({ identity: { env: "local", agentId: "33333333-3333-4333-8333-333333333333" }, actions, spend: { "2026-10-13": 15 }, memory: ["Use US spelling."] }),
      transcript: async () => transcript,
      operator: {
        state: async () => state, events: async () => events,
        setFrozen: record("setFrozen"), setPaused: record("setPaused"), message: record("message"),
        addOrder: record("addOrder"), removeOrder: record("removeOrder"), markChecked: record("markChecked"), retryEvent: record("retryEvent"),
      },
    },
  };
  return { agent, asked };
}
async function serve(agents: ConsoleAgent[] = [fakeAgent().agent]) {
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
  expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(page.headers["content-security-policy"]).toContain("connect-src 'self'");

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

it("moves up one port at a time past ports already in use", async () => {
  const first = await serve();
  const taken = createServer();
  await new Promise<void>((resolve) => taken.listen(first.port + 1, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => taken.close(() => resolve())));
  const next = await startConsole({ port: first.port, token, env: "local", agents: () => [] });
  closers.push(next.close);
  expect(next.port).toBe(first.port + 2);
  expect(next.url).toBe(`http://127.0.0.1:${first.port + 2}/#token=${token}`);
  expect((await call(next.port, "/")).status).toBe(200);
});

it("shows one agent's turns, alerts and prompt", async () => {
  const uncertain = { status: "uncertain" as const, at: "2026-10-13T06:00:00Z", amount: 15, day: "2026-10-13" };
  const { agent } = fakeAgent({
    actions: { "escrow:22222222-2222-4222-8222-222222222222": uncertain, "post:abc": { ...uncertain, status: "done" }, "post:old": uncertain },
    events: { "event:stuck": { kind: "abandoned", attempt: 5, event: { event_id: "stuck", event: "payment_signature_required" }, submission: "s1" as never } },
    transcript: [{ role: "user", content: "Check your marketplace work in your poster role.", timestamp: 1 }, fauxAssistantMessage("Nothing yet.")],
    state: { ...initialOperator(), orders: ["Keep every job under $15."], checked: { "post:old": "2026-10-13T07:00:00Z" } },
  });
  const { port } = await serve([agent]);
  const view = JSON.parse((await call(port, "/api/agents/foo", { headers: auth })).text);
  expect(view.timeline.map((turn: { kind: string }) => turn.kind)).toEqual(["poll"]);
  expect(view.timeline[0].replies[0].text).toBe("Nothing yet.");
  expect(view.attention).toEqual([
    { kind: "uncertain", id: "escrow:22222222-2222-4222-8222-222222222222", at: "2026-10-13T06:00:00Z", amount: 15 },
    { kind: "abandoned", id: "stuck", attempts: 6, event: { event_id: "stuck", event: "payment_signature_required" } },
  ]);
  expect(view.prompt).toContain("Use US spelling.");
  expect(view.prompt).toContain("Keep every job under $15.");
  expect(view.spend).toEqual({ "2026-10-13": 15 });
  expect(view.spec.character.name).toBe(agent.spec.character.name);
  expect((await call(port, "/api/agents/nobody", { headers: auth })).status).toBe(404);
});

it("turns console actions into the agent's operator controls and refuses malformed ones", async () => {
  const { agent, asked } = fakeAgent();
  const { port } = await serve([agent]);
  const post = (path: string, body: unknown) => call(port, `/api/agents/foo/${path}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body });
  expect((await post("paused", { value: true })).status).toBe(204);
  expect((await post("frozen", { value: true })).status).toBe(204);
  expect((await post("messages", { requestId: "r1", text: "Post one job." })).status).toBe(204);
  expect((await post("orders", { text: "Keep jobs small." })).status).toBe(204);
  expect((await call(port, "/api/agents/foo/orders/0", { method: "DELETE", headers: auth })).status).toBe(204);
  expect((await post("checked", { id: "escrow:x" })).status).toBe(204);
  expect((await post("retry", { eventId: "stuck" })).status).toBe(204);
  expect(asked).toEqual([
    ["setPaused", true], ["setFrozen", true], ["message", { requestId: "r1", text: "Post one job." }],
    ["addOrder", "Keep jobs small."], ["removeOrder", 0], ["markChecked", "escrow:x"], ["retryEvent", "stuck"],
  ]);
  for (const [path, body] of [["paused", { value: "yes" }], ["messages", { requestId: "r2", text: "" }], ["messages", { text: "no id" }], ["orders", { text: 7 }], ["checked", {}]] as const) {
    expect((await post(path, body)).status).toBe(400);
  }
  expect((await call(port, "/api/agents/foo/orders/x", { method: "DELETE", headers: auth })).status).toBe(400);
  expect(asked).toHaveLength(7);
});
