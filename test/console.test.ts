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
  const listeners = new Set<() => void>();
  const agent: ConsoleAgent = {
    id,
    spec: parseAgentSpec(JSON.parse(readFileSync(new URL("../examples/brisk-poster.json", import.meta.url), "utf8"))),
    agent: {
      status: async () => ({ identity: { env: "local", agentId: "33333333-3333-4333-8333-333333333333" }, actions, spend: { "2026-10-13": 15 }, memory: ["Use US spelling."] }),
      transcript: async () => transcript,
      changes: (listener) => { listeners.add(listener); return () => void listeners.delete(listener); },
      operator: {
        state: async () => state, events: async () => events,
        setFrozen: record("setFrozen"), setPaused: record("setPaused"), message: record("message"),
        addOrder: record("addOrder"), removeOrder: record("removeOrder"), markChecked: record("markChecked"), retryEvent: record("retryEvent"),
      },
    },
  };
  // Stands in for a store commit: every watcher hears it.
  const commit = () => listeners.forEach((listener) => listener());
  return { agent, asked, listeners, commit };
}
async function serve(agents: ConsoleAgent[] = [fakeAgent().agent], options: Partial<Parameters<typeof startConsole>[0]> = {}) {
  const consoleServer = await startConsole({ port: 0, token, env: "local", agents: () => agents, ...options });
  closers.push(consoleServer.close);
  return consoleServer;
}
function call(port: number, path: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  // A string body is sent verbatim, so tests can post non-JSON.
  const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
    // Node frames a body by itself only for some methods, so always set its length.
    const length = data === undefined ? {} : { "content-length": String(Buffer.byteLength(data)) };
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...length, ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => { text += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(data);
  });
}
const auth = { authorization: `Bearer ${token}` };
// Opens an event stream and hands back its frames one at a time: `view` events
// parsed, comments as { comment }.
type Frame = { event: string; data: unknown } | { comment: string };
function stream(port: number, path = "/api/agents/foo/stream", headers: Record<string, string> = auth) {
  return new Promise<{ status: number; headers: Record<string, unknown>; next(): Promise<Frame>; ended: Promise<void>; close(): void }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let buffer = "";
      const frames: Frame[] = [];
      const waiting: ((frame: Frame) => void)[] = [];
      const ended = new Promise<void>((done) => res.on("close", done));
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const frame: Frame = block.startsWith(":")
            ? { comment: block.slice(1).trim() }
            : { event: /^event: (.*)$/m.exec(block)?.[1] ?? "", data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null") };
          const take = waiting.shift();
          if (take) take(frame);
          else frames.push(frame);
        }
      });
      closers.push(async () => { req.destroy(); });
      resolve({
        status: res.statusCode ?? 0, headers: res.headers, ended, close: () => req.destroy(),
        next: () => { const frame = frames.shift(); return frame ? Promise.resolve(frame) : new Promise((take) => waiting.push(take)); },
      });
    });
    req.on("error", reject);
    req.end();
  });
}

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

it("streams only to this machine's own pages, only with the token in the header, and offers no CORS", async () => {
  const { port } = await serve();
  expect((await call(port, "/api/agents/foo/stream")).status).toBe(401);
  expect((await call(port, `/api/agents/foo/stream?token=${token}`)).status).toBe(401);
  expect((await call(port, "/api/agents/foo/stream", { headers: { ...auth, host: `rebound.example:${port}` } })).status).toBe(403);
  expect((await call(port, "/api/agents/foo/stream", { headers: { ...auth, origin: "https://elsewhere.example" } })).status).toBe(403);
  expect((await call(port, "/api/agents/nobody/stream", { headers: auth })).status).toBe(404);

  const live = await stream(port);
  expect(live.status).toBe(200);
  expect(live.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
  expect(live.headers["cache-control"]).toBe("no-store");
  expect(Object.keys(live.headers).filter((name) => name.startsWith("access-control-"))).toEqual([]);
});

it("sends the current view on connect, then one view per burst of commits", async () => {
  const state = initialOperator();
  const { agent, commit } = fakeAgent({ state });
  const { port } = await serve([agent], { coalesceMs: 30 });
  const live = await stream(port);
  const first = await live.next();
  expect(first).toEqual({ event: "view", data: JSON.parse((await call(port, "/api/agents/foo", { headers: auth })).text) });

  for (const order of ["a", "b", "c", "d", "e"]) { state.orders.push(order); commit(); }
  expect(await live.next()).toMatchObject({ event: "view", data: { operator: { orders: ["a", "b", "c", "d", "e"] } } });
  await new Promise((done) => setTimeout(done, 100));
  state.orders.push("f");
  commit();
  expect(await live.next()).toMatchObject({ event: "view", data: { operator: { orders: ["a", "b", "c", "d", "e", "f"] } } });
});

it("pings an idle stream, and resends the view when something outside the store changed", async () => {
  const state = initialOperator();
  const { agent } = fakeAgent({ state });
  const { port } = await serve([agent], { pingMs: 30 });
  const live = await stream(port);
  expect(await live.next()).toMatchObject({ event: "view" });
  expect(await live.next()).toEqual({ comment: "ping" });
  expect(await live.next()).toEqual({ comment: "ping" });
  state.paused = true;
  let frame: Frame;
  do frame = await live.next(); while ("comment" in frame);
  expect(frame).toMatchObject({ event: "view", data: { operator: { paused: true } } });
});

it("caps open streams, and frees a place when one closes", async () => {
  const { port } = await serve(undefined, { maxStreams: 2 });
  const [one] = [await stream(port), await stream(port)];
  const refused = await call(port, "/api/agents/foo/stream", { headers: auth });
  expect(refused.status).toBe(429);
  expect(JSON.parse(refused.text)).toEqual({ error: "too many open streams" });
  await one.next();
  one.close();
  await one.ended;
  await new Promise((done) => setTimeout(done, 20));
  expect((await stream(port)).status).toBe(200);
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
  const { agent, asked } = fakeAgent({ state: { ...initialOperator(), orders: ["Decline weekend work."] } });
  const { port } = await serve([agent]);
  const post = (path: string, body: unknown) => call(port, `/api/agents/foo/${path}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body });
  expect((await post("paused", { value: true })).status).toBe(204);
  expect((await post("frozen", { value: true })).status).toBe(204);
  expect((await post("messages", { requestId: "r1", text: "Post one job." })).status).toBe(204);
  expect((await post("orders", { text: "Keep jobs small." })).status).toBe(204);
  expect((await call(port, "/api/agents/foo/orders/0", { method: "DELETE", headers: { ...auth, "content-type": "application/json" }, body: { expect: "Decline weekend work." } })).status).toBe(204);
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

it("refuses to listen without a token", async () => {
  await expect(startConsole({ port: 0, token: "", env: "local", agents: () => [] })).rejects.toThrow("console: token required");
});

it("answers a malformed percent-escape with not found, not a server error", async () => {
  const { port } = await serve();
  expect((await call(port, "/api/agents/%zz", { headers: auth })).status).toBe(404);
});

it("refuses oversize or non-JSON bodies before any control runs", async () => {
  const { agent, asked } = fakeAgent();
  const { port } = await serve([agent]);
  const post = (body: unknown) => call(port, "/api/agents/foo/paused", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body });
  // Exactly one byte past the 64 KiB body limit.
  const pad = "x".repeat(65537 - JSON.stringify({ value: true, pad: "" }).length);
  expect((await post({ value: true, pad })).status).toBe(400);
  expect((await post("definitely not json")).status).toBe(400);
  expect(asked).toHaveLength(0);
});

it("renders the page with text only, never a markup sink", async () => {
  const { port } = await serve();
  const page = await call(port, "/");
  expect(page.status).toBe(200);
  for (const sink of [".innerHTML", "insertAdjacentHTML", "outerHTML", "document.write", "srcdoc"]) {
    expect(page.text).not.toContain(sink);
  }
});

it("removes an order only when the rendered text still matches", async () => {
  const { agent, asked } = fakeAgent({ state: { ...initialOperator(), orders: ["Keep jobs small.", "Be brief."] } });
  const { port } = await serve([agent]);
  const remove = (index: number, body: unknown) =>
    call(port, `/api/agents/foo/orders/${index}`, { method: "DELETE", headers: { ...auth, "content-type": "application/json" }, body });
  expect((await remove(1, {})).status).toBe(400);
  const stale = await remove(1, { expect: "Keep jobs small." });
  expect(stale.status).toBe(409);
  expect(JSON.parse(stale.text)).toEqual({ error: "orders changed; refresh" });
  expect((await remove(1, { expect: "Be brief." })).status).toBe(204);
  expect(asked).toEqual([["removeOrder", 1]]);
});
