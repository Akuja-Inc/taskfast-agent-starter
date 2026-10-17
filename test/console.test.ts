import { createServer, request } from "node:http";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { COALESCE_MS, MAX_STREAMS, PING_MS, startConsole, type ConsoleAgent } from "../src/console.js";
import { initialOperator, type OperatorState } from "../src/core/operator.js";
import { parseAgentSpec } from "../src/core/spec.js";
import { example } from "./example.js";

const token = "a".repeat(64);
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

// One agent whose controls record what the console asked of them.
type Ledger = Awaited<ReturnType<ConsoleAgent["agent"]["status"]>>;
type Work = Awaited<ReturnType<ConsoleAgent["agent"]["operator"]["events"]>>;
type QueuedMessages = Awaited<ReturnType<ConsoleAgent["agent"]["operator"]["queued"]>>;
type SteerResult = Awaited<ReturnType<ConsoleAgent["agent"]["operator"]["steer"]>>;
type WithdrawResult = Awaited<ReturnType<ConsoleAgent["agent"]["operator"]["withdraw"]>>;
function fakeAgent({ id = "foo", actions = {}, events = {}, transcript = [], state = initialOperator(), queuedMessages = [], steerResult = "steered", withdrawResult = "withdrawn" }: {
  id?: string; actions?: Ledger["actions"]; events?: Work; transcript?: Message[]; state?: OperatorState;
  queuedMessages?: QueuedMessages;
  steerResult?: SteerResult;
  withdrawResult?: WithdrawResult;
} = {}) {
  const asked: unknown[][] = [];
  const record = (name: string) => async (...args: unknown[]) => { asked.push([name, ...args]); };
  const listeners = new Set<() => void>();
  const agent: ConsoleAgent = {
    id,
    spec: parseAgentSpec(example("brisk-poster")),
    agent: {
      status: async () => ({ identity: { env: "local", agentId: "33333333-3333-4333-8333-333333333333" }, actions, spend: { "2026-10-13": 15 }, memory: ["Use US spelling."] }),
      transcript: async () => transcript,
      changes: (listener) => { listeners.add(listener); return () => void listeners.delete(listener); },
      operator: {
        state: async () => state, events: async () => events, queued: async () => queuedMessages,
        steer: async (requestId: string) => { asked.push(["steer", requestId]); return steerResult; },
        withdraw: async (requestId: string) => { asked.push(["withdraw", requestId]); return withdrawResult; },
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

it.each([
  { method: "POST", path: "messages", next: "starting" },
  { method: "POST", path: "messages", next: "ready" },
  { method: "DELETE", path: "orders/0", next: "starting" },
  { method: "PUT", path: "spec", next: "ready" },
] as const)("rejects $method $path whose body spans a transition to $next", async ({ method, path, next }) => {
  const fake = fakeAgent({ state: { ...initialOperator(), orders: ["old order"] } });
  const save = vi.fn(async () => {});
  fake.agent.saveSpec = save;
  let generation = 1;
  let state: "ready" | "starting" = "ready";
  let observed!: () => void;
  const captured = new Promise<void>((resolve) => { observed = resolve; });
  const server = await serve([fake.agent], { roster: () => {
    observed();
    return [{ id: "foo", generation, ...(state === "ready" ? { state } : { state, phase: "waiting-for-close" as const }) }];
  } });
  const body = JSON.stringify(path === "spec" ? fake.agent.spec : path.startsWith("orders") ? { expect: "old order" } : { requestId: "chunked-1", text: "Do work" });
  let finish!: () => void;
  const response = new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path: `/api/agents/foo/${path}`, method,
      headers: { ...auth, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.write(body.slice(0, 1));
    finish = () => req.end(body.slice(1));
  });
  await captured;
  generation++; state = next;
  finish();
  expect(await response).toBe(409);
  expect(fake.asked).toEqual([]);
  expect(save).not.toHaveBeenCalled();
});
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

it("sends a view within the first window even when a commit lands mid-window", async () => {
  const state = initialOperator();
  const { agent, commit } = fakeAgent({ state });
  const { port } = await serve([agent], { coalesceMs: 120 });
  const live = await stream(port);
  await live.next();
  const started = Date.now();
  state.orders.push("a");
  commit();
  await new Promise((done) => setTimeout(done, 80));
  state.orders.push("b");
  commit();
  const frame = await live.next();
  // The window runs from the first commit: a resettable timer would not fire until a
  // full window after the second one, past this deadline.
  expect(Date.now() - started).toBeLessThanOrEqual(120 + 60);
  expect(frame).toMatchObject({ event: "view", data: { operator: { orders: ["a", "b"] } } });
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

it("closing an agent's streams waits for a view read already under way", async () => {
  const { agent } = fakeAgent();
  let release = () => {};
  let reading = () => {};
  const started = new Promise<void>((done) => { reading = done; });
  const read = agent.agent.transcript;
  agent.agent.transcript = async (limit) => { reading(); await new Promise<void>((done) => { release = done; }); return read(limit); };
  const consoleServer = await serve([agent]);
  const live = await stream(consoleServer.port);
  await started;
  let closed = false;
  const closing = consoleServer.closeStreams("foo").then(() => { closed = true; });
  await new Promise((done) => setTimeout(done, 30));
  expect(closed).toBe(false);
  release();
  await closing;
  await live.ended;
  expect(closed).toBe(true);
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
  // Nothing to await for the server's close bookkeeping: poll until the place is freed.
  await vi.waitFor(async () => expect((await stream(port)).status).toBe(200), { interval: 20, timeout: 1_000 });
});

it("uses the shipped coalescing, ping and stream cap when nothing overrides them", async () => {
  expect(COALESCE_MS).toBe(250);
  expect(PING_MS).toBe(15_000);
  expect(MAX_STREAMS).toBe(8);
  const { port } = await serve();
  const live: Awaited<ReturnType<typeof stream>>[] = [];
  for (let at = 0; at < MAX_STREAMS; at++) live.push(await stream(port));
  expect(live.map((open) => open.status)).toEqual(Array(MAX_STREAMS).fill(200));
  const ninth = await call(port, "/api/agents/foo/stream", { headers: auth });
  expect(ninth.status).toBe(429);
  expect(JSON.parse(ninth.text)).toEqual({ error: "too many open streams" });
});

it("a spec save ends one agent's stream under the shared cap and leaves the others alone", async () => {
  const spec = parseAgentSpec(example("brisk-poster"));
  const stateTwo = initialOperator();
  const one = fakeAgent({ id: "one" });
  const reopened = fakeAgent({ id: "one" });
  const two = fakeAgent({ id: "two", state: stateTwo });
  const list = [one.agent, two.agent];
  const consoleServer = await serve(list, { coalesceMs: 30, maxStreams: 2 });
  const { port } = consoleServer;
  // As the host's saveSpec does: end this agent's streams, then serve a fresh agent.
  one.agent.saveSpec = async () => {
    await consoleServer.closeStreams("one");
    list[0] = reopened.agent;
  };
  const saved = await stream(port, "/api/agents/one/stream");
  const survivor = await stream(port, "/api/agents/two/stream");
  await saved.next();
  await survivor.next();
  // The cap counts every agent's streams together: two open, no place left.
  expect((await call(port, "/api/agents/two/stream", { headers: auth })).status).toBe(429);
  expect((await call(port, "/api/agents/one/spec", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: spec })).status).toBe(204);
  await saved.ended;
  const again = await stream(port, "/api/agents/one/stream");
  expect(again.status).toBe(200);
  await again.next();
  stateTwo.orders.push("still going");
  two.commit();
  expect(await survivor.next()).toMatchObject({ event: "view", data: { operator: { orders: ["still going"] } } });
});

it("validates polling intervals at the console boundary before calling saveSpec", async () => {
  const { agent } = fakeAgent();
  const saved: unknown[] = [];
  agent.saveSpec = async (spec) => { saved.push(spec); };
  const { port } = await serve([agent]);
  for (const pollIntervalMinutes of [0, -1, 1.5, 1441, "5", "", null]) {
    const response = await call(port, "/api/agents/foo/spec", { method: "PUT", headers: auth, body: { ...agent.spec, pollIntervalMinutes } });
    expect(response.status).toBe(400);
    expect(response.text).toContain("pollIntervalMinutes must be a whole number from 1 to 1440");
  }
  expect(saved).toEqual([]);
  const body = { ...agent.spec, pollIntervalMinutes: 7 };
  expect((await call(port, "/api/agents/foo/spec", { method: "PUT", headers: auth, body })).status).toBe(204);
  expect(saved).toEqual([body]);
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
  expect(view.spec.instructions).toBe(agent.spec.instructions);
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

it("withdraws by immutable request ID and maps operator outcomes to HTTP status", async () => {
  for (const withdrawResult of ["withdrawn", "already_placed", "not_found"] as const) {
    const { agent, asked } = fakeAgent({ withdrawResult });
    const { port } = await serve([agent]);
    for (let retry = 0; retry < 2; retry++) {
      const result = await call(port, "/api/agents/foo/messages/follow-up_1", { method: "DELETE", headers: auth });
      expect(result.status).toBe(withdrawResult === "withdrawn" ? 204 : withdrawResult === "already_placed" ? 409 : 404);
      if (withdrawResult === "withdrawn") expect(result.text).toBe("");
      else expect(JSON.parse(result.text)).toEqual({ error: withdrawResult === "already_placed" ? "The agent already has this message." : "Queued message not found." });
    }
    expect(asked).toEqual([["withdraw", "follow-up_1"], ["withdraw", "follow-up_1"]]);
  }
});

it("guards withdrawal with authentication, origin, method and the shared request-ID validation", async () => {
  const { agent, asked } = fakeAgent();
  const { port } = await serve([agent]);
  const path = "/api/agents/foo/messages/r1";
  expect((await call(port, path, { method: "DELETE" })).status).toBe(401);
  expect((await call(port, path, { method: "DELETE", headers: { ...auth, origin: "http://evil.test" } })).status).toBe(403);
  for (const method of ["GET", "POST", "PUT"]) expect((await call(port, path, { method, headers: auth })).status).toBe(404);
  for (const id of ["%20", "%2F", "bad%id", "x".repeat(129)]) expect((await call(port, "/api/agents/foo/messages/" + id, { method: "DELETE", headers: auth })).status).toBe(400);
  expect((await call(port, "/api/agents/foo/messages", { method: "DELETE", headers: auth })).status).toBe(404);
  expect(asked).toEqual([]);
  expect((await call(port, path, { method: "DELETE", headers: auth })).status).toBe(204);
  expect(asked).toEqual([["withdraw", "r1"]]);
});

it("admits follow-ups and explicit steers without changing their request identity", async () => {
  const { agent, asked } = fakeAgent();
  const { port } = await serve([agent]);
  for (const body of [
    { requestId: "follow-up_1", text: "When you finish." },
    { requestId: "steer_1", text: "Change direction.", steer: true },
  ]) {
    expect((await call(port, "/api/agents/foo/messages", { method: "POST", headers: auth, body })).status).toBe(204);
    expect(asked.at(-1)).toEqual(["message", body]);
  }
});

it("rejects every supplied steer value except true before admitting a message", async () => {
  const { agent, asked } = fakeAgent();
  const { port } = await serve([agent]);
  for (const steer of [false, null, "true", "false", 0, 1, [], {}]) {
    const result = await call(port, "/api/agents/foo/messages", { method: "POST", headers: auth, body: { requestId: "r1", text: "Go.", steer } });
    expect(result.status).toBe(400);
    expect(JSON.parse(result.text)).toEqual({ error: "steer must be true or omitted" });
  }
  expect(asked).toEqual([]);
});

it("promotes by request ID and maps successful, idempotent, late and missing results", async () => {
  for (const steerResult of ["steered", "already_placed", "not_found"] as const) {
    const { agent, asked } = fakeAgent({ steerResult });
    const { port } = await serve([agent]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await call(port, "/api/agents/foo/steer/follow-up_1", { method: "POST", headers: auth });
      expect(result.status).toBe(steerResult === "steered" ? 204 : steerResult === "already_placed" ? 409 : 404);
      if (steerResult === "steered") expect(result.text).toBe("");
      else expect(JSON.parse(result.text)).toEqual({ error: steerResult === "already_placed" ? "The agent already has this message." : "Queued message not found." });
    }
    expect(asked).toEqual([["steer", "follow-up_1"], ["steer", "follow-up_1"]]);
  }
});

it("applies the same strict request ID grammar to sends and promotions", async () => {
  const { agent, asked } = fakeAgent();
  const { port } = await serve([agent]);
  for (const requestId of ["bad.id", "bad%id", "%2F", "%zz", "a".repeat(101)]) {
    for (const [path, body] of [
      ["messages", { requestId, text: "Go." }],
      [`steer/${requestId}`, undefined],
    ] as const) {
      const result = await call(port, `/api/agents/foo/${path}`, { method: "POST", headers: auth, body });
      expect(result.status).toBe(400);
      expect(JSON.parse(result.text)).toEqual({ error: "requestId must be 1-100 letters, digits, - or _" });
    }
  }
  const requestId = "A_9-" + "x".repeat(96);
  expect((await call(port, `/api/agents/foo/steer/${requestId}`, { method: "POST", headers: auth })).status).toBe(204);
  expect(asked).toEqual([["steer", requestId]]);
});

it("protects promotion with the existing token, host and origin checks", async () => {
  const { agent, asked } = fakeAgent();
  const { port } = await serve([agent]);
  const path = "/api/agents/foo/steer/r1";
  const deniedHeaders: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }];
  for (const headers of deniedHeaders) {
    expect((await call(port, path, { method: "POST", headers })).status).toBe(401);
  }
  expect((await call(port, path, { method: "POST", headers: { ...auth, host: `rebound.example:${port}` } })).status).toBe(403);
  expect((await call(port, path, { method: "POST", headers: { ...auth, origin: "https://elsewhere.example" } })).status).toBe(403);
  expect(asked).toEqual([]);
  expect((await call(port, path, { method: "POST", headers: { ...auth, origin: `http://localhost:${port}` } })).status).toBe(204);
  expect(asked).toEqual([["steer", "r1"]]);
});

it("does not ignore extra path arguments on existing actions", async () => {
  const { agent, asked } = fakeAgent();
  agent.saveSpec = async () => { asked.push(["saveSpec"]); };
  const { port } = await serve([agent]);
  for (const [action, body] of [
    ["paused", { value: true }], ["frozen", { value: true }], ["messages", { requestId: "r1", text: "Go." }],
    ["orders", { text: "Be brief." }], ["checked", { id: "x" }], ["retry", { eventId: "x" }],
  ] as const) {
    expect((await call(port, `/api/agents/foo/${action}/ignored`, { method: "POST", headers: auth, body })).status).toBe(404);
  }
  expect((await call(port, "/api/agents/foo/spec/ignored", { method: "PUT", headers: auth, body: agent.spec })).status).toBe(404);
  expect((await call(port, "/api/agents/foo/stream/ignored", { headers: auth })).status).toBe(404);
  expect((await call(port, "/api/agents/foo/steer", { method: "POST", headers: auth })).status).toBe(404);
  expect((await call(port, "/api/agents/foo/steer/r1/ignored", { method: "POST", headers: auth })).status).toBe(404);
  expect((await call(port, "/api/agents/foo/steer/r1", { method: "GET", headers: auth })).status).toBe(404);
  expect(asked).toEqual([]);
});

it("publishes the core's queue unchanged in reads and streamed views, including while paused", async () => {
  const queuedMessages: QueuedMessages = [
    { requestId: "old", text: "<script>literal words</script>", mode: "followUp" },
    { requestId: "new", text: "Change direction.", mode: "steer" },
  ];
  const { agent, commit } = fakeAgent({ state: { ...initialOperator(), paused: true }, queuedMessages });
  const { port } = await serve([agent], { coalesceMs: 1 });
  const result = await call(port, "/api/agents/foo", { headers: auth });
  expect(result.status).toBe(200);
  expect(JSON.parse(result.text).queuedMessages).toEqual(queuedMessages);
  const live = await stream(port);
  expect(await live.next()).toMatchObject({ event: "view", data: { queuedMessages } });
  queuedMessages.splice(0, 1);
  commit();
  expect(await live.next()).toMatchObject({ event: "view", data: { queuedMessages: [{ requestId: "new", text: "Change direction.", mode: "steer" }] } });
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
