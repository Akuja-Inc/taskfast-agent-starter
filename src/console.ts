import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PAGE } from "./console-page.js";
import type { MarketplaceAgent } from "./core/agent.js";
import { marketplacePrompt } from "./core/prompt.js";
import { parseAgentSpec } from "./core/spec.js";
import { buildTimeline } from "./core/timeline.js";
import type { AgentSpec, Env } from "./core/types.js";

// What the console needs from one running agent.
export interface ConsoleAgent {
  id: string;
  spec: AgentSpec;
  agent: Pick<MarketplaceAgent, "operator" | "status" | "transcript" | "changes">;
  // Writes an already-checked agent file and reopens this agent with it.
  saveSpec?(spec: AgentSpec): Promise<void>;
  // What only the host knows, with server reads for the given task IDs.
  host?(taskIds: string[]): Promise<HostFacts>;
}
export interface HostFacts {
  unlockFile: boolean;
  stream: "starting" | "connected" | "reconnecting" | "restarting" | "auth failed";
  wallet?: unknown;
  tasks: Record<string, unknown>;
  // dead-letter.jsonl records: events the stream gave up on and acknowledged.
  deadLetters: { at: string; reason: string; line: string }[];
}
export interface ConsoleOptions {
  // 0 picks a free port.
  port: number;
  // Required on every /api request as a bearer token. Never written into the page.
  token: string;
  env: Env;
  agents(): ConsoleAgent[];
  // Event stream tuning; tests pass small values.
  coalesceMs?: number;
  pingMs?: number;
  maxStreams?: number;
}

// Enough recent history for the timeline without paging; older turns stay in the store.
const TRANSCRIPT_ENTRIES = 400;
// Task cards read the newest tasks the timeline mentions, at most this many.
const TASK_READS = 20;
const MAX_BODY = 64 * 1024;
function eventIdOf(line: string): string | undefined {
  try {
    const value: unknown = JSON.parse(line);
    const id = field(value, "event_id");
    return typeof id === "string" ? id : undefined;
  } catch { return undefined; }
}
const MAX_TEXT = 4000;
// A burst of commits (a model's partial answers land every ~100 ms) becomes one view.
const COALESCE_MS = 250;
const PING_MS = 15_000;
const MAX_STREAMS = 8;

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}
const field = (body: unknown, key: string): unknown => (typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined);
const words = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT;

// Validates one console action and hands it to the agent. Returns undefined when done,
// a reason when the body is malformed, or null for an unknown action.
async function act(controls: ConsoleAgent["agent"]["operator"], action: string | undefined, body: unknown): Promise<string | null | undefined> {
  const value = field(body, "value");
  switch (action) {
    case "paused":
    case "frozen":
      if (typeof value !== "boolean") return "value must be true or false";
      await (action === "paused" ? controls.setPaused(value) : controls.setFrozen(value));
      return undefined;
    case "messages": {
      const requestId = field(body, "requestId");
      const text = field(body, "text");
      if (typeof requestId !== "string" || !/^[\w-]{1,100}$/.test(requestId)) return "requestId must be 1-100 letters, digits, - or _";
      if (!words(text)) return `text must be 1-${MAX_TEXT} characters`;
      await controls.message({ requestId, text });
      return undefined;
    }
    case "orders": {
      const text = field(body, "text");
      if (!words(text)) return `text must be 1-${MAX_TEXT} characters`;
      await controls.addOrder(text);
      return undefined;
    }
    case "checked": {
      const id = field(body, "id");
      if (typeof id !== "string" || !id || id.length > 300) return "id is required";
      await controls.markChecked(id);
      return undefined;
    }
    case "retry": {
      const eventId = field(body, "eventId");
      if (typeof eventId !== "string" || !eventId || eventId.length > 300) return "eventId is required";
      await controls.retryEvent(eventId);
      return undefined;
    }
    default:
      return null;
  }
}

// One agent as GET /api/agents/:id and its stream show it.
export type ConsoleView = Awaited<ReturnType<typeof view>>;
async function view(env: Env, { id, spec, agent, host }: ConsoleAgent) {
  const [policy, operator, events, transcript] = await Promise.all([agent.status(), agent.operator.state(), agent.operator.events(), agent.transcript(TRANSCRIPT_ENTRIES)]);
  const timeline = buildTimeline(transcript);
  const taskIds = [...new Set(timeline.flatMap((turn) => turn.replies.flatMap((reply) => reply.tasks.map((task) => task.id))))].slice(-TASK_READS);
  const facts = await host?.(taskIds);
  const deadLetters = (facts?.deadLetters ?? []).map((record) => ({ kind: "dead-letter" as const, id: `dead-letter:${eventIdOf(record.line) ?? record.at}`, ...record }));
  const attention = [
    ...Object.entries(policy.actions).filter(([key, action]) => action.status === "uncertain" && !operator.checked[key])
      .map(([key, action]) => ({ kind: "uncertain" as const, id: key, at: action.at, amount: action.amount })),
    ...Object.entries(events).filter(([key, work]) => work.kind === "abandoned" && !operator.checked[key])
      .map(([key, work]) => ({ kind: "abandoned" as const, id: key.slice("event:".length), attempts: work.attempt + 1, event: work.event })),
    ...deadLetters.filter((letter) => !operator.checked[letter.id]),
  ];
  return {
    id, env, spec, operator, attention, events,
    actions: policy.actions, spend: policy.spend, notes: policy.memory,
    prompt: marketplacePrompt(spec, policy.memory, operator.orders),
    timeline, host: facts && { unlockFile: facts.unlockFile, stream: facts.stream, wallet: facts.wallet, tasks: facts.tasks },
  };
}

// The page may run only its own inline code and talk only to this server.
const PAGE_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  const text = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    ...(type === "text/html" ? { "content-security-policy": PAGE_POLICY } : {}),
  });
  res.end(text);
}
function sameToken(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

// Listens on 127.0.0.1 at `port`, or the next free port above it, one at a time.
// Port 0 lets the system pick. Any error other than a taken port is thrown.
const PORT_TRIES = 100;
async function listenFrom(server: Server, port: number): Promise<number> {
  for (let at = port; ; at++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { server.off("listening", listening); reject(error); };
        const listening = () => { server.off("error", failed); resolve(); };
        server.once("error", failed).once("listening", listening).listen(at, "127.0.0.1");
      });
      return (server.address() as AddressInfo).port;
    } catch (error) {
      const taken = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
      if (!taken || port === 0 || at >= Math.min(65535, port + PORT_TRIES - 1)) {
        throw taken ? new Error(`console: ports ${port}-${at} are all in use; pass --console-port`, { cause: error }) : error;
      }
    }
  }
}

// The local console: this machine only. A foreign Host is a rebound DNS name and a
// foreign Origin is another site's page; both are refused, and no CORS is offered.
export async function startConsole(o: ConsoleOptions): Promise<{ url: string; port: number; closeStreams(id?: string): Promise<void>; close(): Promise<void> }> {
  // An empty token would compare equal to a missing bearer header and serve every request.
  if (!o.token) throw new Error("console: token required");
  let port = 0;
  const open = new Set<{ id: string; end(): void; settled(): Promise<void> }>();
  const own = () => [`127.0.0.1:${port}`, `localhost:${port}`];
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => send(res, 500, { error: error instanceof Error ? error.message : String(error) }));
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!own().includes(req.headers.host ?? "")) return send(res, 403, { error: "unknown host" });
    if (req.method === "OPTIONS") return send(res, 405, { error: "no cross-origin requests" });
    if (req.headers.origin !== undefined && !own().some((host) => req.headers.origin === `http://${host}`)) return send(res, 403, { error: "unknown origin" });
    const path = new URL(req.url ?? "/", "http://console").pathname;
    if (req.method === "GET" && path === "/") return send(res, 200, PAGE, "text/html");
    if (!sameToken(req.headers.authorization, o.token)) return send(res, 401, { error: "missing or wrong console token" });
    if (req.method === "GET" && path === "/api/agents") {
      return send(res, 200, { env: o.env, agents: o.agents().map(({ id, spec }) => ({ id, name: spec.character.name, role: spec.role })) });
    }
    const match = /^\/api\/agents\/([^/]+)(?:\/([a-z]+)(?:\/([^/]+))?)?$/.exec(path);
    // A malformed percent-escape names no agent: not found, not a server error.
    let id: string | undefined;
    try { id = match ? decodeURIComponent(match[1]) : undefined; } catch { id = undefined; }
    const item = id === undefined ? undefined : o.agents().find((candidate) => candidate.id === id);
    if (!item) return send(res, 404, { error: "not found" });
    const [, , action, arg] = match ?? [];
    if (req.method === "GET" && !action) return send(res, 200, await view(o.env, item));
    if (req.method === "GET" && action === "stream" && arg === undefined) return watch(item, res);
    const controls = item.agent.operator;
    if (req.method === "DELETE" && action === "orders" && arg !== undefined) {
      if (!/^\d+$/.test(arg)) return send(res, 400, { error: "order index must be a whole number" });
      // The page sends the text it rendered, so a stale render cannot remove the wrong order.
      const expected = field(await readJson(req), "expect");
      if (typeof expected !== "string") return send(res, 400, { error: "expect must be the current order text" });
      if ((await controls.state()).orders[Number(arg)] !== expected) return send(res, 409, { error: "orders changed; refresh" });
      await controls.removeOrder(Number(arg));
      return send(res, 204, "");
    }
    if (req.method === "PUT" && action === "spec" && item.saveSpec) {
      let spec: AgentSpec;
      try { spec = parseAgentSpec(await readJson(req)); }
      catch (error) { return send(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      await item.saveSpec(spec);
      return send(res, 204, "");
    }
    if (req.method !== "POST") return send(res, 404, { error: "not found" });
    const body = await readJson(req);
    const problem = await act(controls, action, body);
    return problem === undefined ? send(res, 204, "") : send(res, problem === null ? 404 : 400, { error: problem ?? "not found" });
  }
  // One live view: sent on connect, then once per window after any commit. The window
  // is fixed, not reset by each commit, so a model streaming partial answers can't starve it.
  function watch(item: ConsoleAgent, res: ServerResponse): void {
    if (open.size >= (o.maxStreams ?? MAX_STREAMS)) return send(res, 429, { error: "too many open streams" });
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    res.flushHeaders();
    let last = "";
    let timer: NodeJS.Timeout | undefined;
    let sending = Promise.resolve();
    const push = () => {
      sending = sending.then(async () => {
        const data = JSON.stringify(await view(o.env, item));
        if (data === last || res.writableEnded) return;
        last = data;
        res.write(`event: view\ndata: ${data}\n\n`);
      }).catch(end);
    };
    const unsubscribe = item.agent.changes(() => { timer ??= setTimeout(() => { timer = undefined; push(); }, o.coalesceMs ?? COALESCE_MS); });
    // Keeps idle connections open, and picks up host facts (stream, wallet) that change without a commit.
    const ping = setInterval(() => { res.write(": ping\n\n"); push(); }, o.pingMs ?? PING_MS);
    const stream = { id: item.id, end, settled: () => sending };
    function end() {
      if (!open.delete(stream)) return;
      clearTimeout(timer);
      clearInterval(ping);
      unsubscribe();
      res.end();
    }
    open.add(stream);
    res.on("close", end);
    push();
  }
  // Ends streams at once, not on a later socket event, then waits out any view read
  // already under way, so none reads an agent's store after it starts to close.
  async function closeStreams(id?: string): Promise<void> {
    const closing = [...open].filter((stream) => id === undefined || stream.id === id);
    for (const stream of closing) stream.end();
    await Promise.allSettled(closing.map((stream) => stream.settled()));
  }
  port = await listenFrom(server, o.port);
  return {
    url: `http://127.0.0.1:${port}/#token=${o.token}`,
    port,
    closeStreams,
    close: async () => {
      await closeStreams();
      await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    },
  };
}
