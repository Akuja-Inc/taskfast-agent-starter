import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PAGE } from "./console-page.js";
import type { EventWork, MarketplaceAgent } from "./core/agent.js";
import type { Action } from "./core/policy.js";
import { marketplacePrompt } from "./core/prompt.js";
import { parseAgentSpec } from "./core/spec.js";
import { buildTimeline } from "./core/timeline.js";
import type { AgentSpec, Env } from "./core/types.js";
import type { AgentRosterEntry, StartupAction } from "./console-lifecycle.js";

// What the console needs from one running agent.
export interface ConsoleAgent {
  id: string;
  spec: AgentSpec;
  agent: Pick<MarketplaceAgent, "operator" | "status" | "transcript" | "changes">;
  // Writes an already-checked agent.json and INSTRUCTIONS.md and reopens this agent with them.
  saveSpec?(spec: AgentSpec): Promise<void>;
  // What only the host knows, with server reads for the given task IDs. `seen` is the
  // ledger this view read, so the host can tell when money has moved.
  host?(taskIds: string[], seen: Ledger): Promise<HostFacts>;
}
export interface Ledger {
  actions: Record<string, Action>;
  events: Record<string, EventWork>;
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
  // Management remains available before an agent has a durable handle.
  roster?(): AgentRosterEntry[];
  // Schedules lifecycle intent without waiting for connection or cleanup.
  startup?(request: StartupAction): boolean;
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
const REQUEST_ID_PROBLEM = "requestId must be 1-100 letters, digits, - or _";
const validRequestId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,100}$/.test(value);
// A burst of commits (a model's partial answers land every ~100 ms) becomes one view.
export const COALESCE_MS = 250;
export const PING_MS = 15_000;
export const MAX_STREAMS = 8;
// Past this many bytes queued for one reader it has stalled: end its stream rather than buffer views forever.
const MAX_BUFFERED_BYTES = 1024 * 1024;

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
      const steer = field(body, "steer");
      if (!validRequestId(requestId)) return REQUEST_ID_PROBLEM;
      if (!words(text)) return `text must be 1-${MAX_TEXT} characters`;
      if (steer !== undefined && steer !== true) return "steer must be true or omitted";
      await controls.message({ requestId, text, ...(steer === true ? { steer } : {}) });
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
  const [policy, operator, events, transcript, queuedMessages] = await Promise.all([agent.status(), agent.operator.state(), agent.operator.events(), agent.transcript(TRANSCRIPT_ENTRIES), agent.operator.queued()]);
  const timeline = buildTimeline(transcript);
  const taskIds = [...new Set(timeline.flatMap((turn) => turn.replies.flatMap((reply) => reply.tasks.map((task) => task.id))))].slice(-TASK_READS);
  const facts = await host?.(taskIds, { actions: policy.actions, events });
  const deadLetters = (facts?.deadLetters ?? []).map((record) => ({ kind: "dead-letter" as const, id: `dead-letter:${eventIdOf(record.line) ?? record.at}`, ...record }));
  const attention = [
    ...Object.entries(policy.actions).filter(([key, action]) => action.status === "uncertain" && !operator.checked[key])
      .map(([key, action]) => ({ kind: "uncertain" as const, id: key, at: action.at, amount: action.amount })),
    ...Object.entries(events).filter(([key, work]) => work.kind === "abandoned" && !operator.checked[key])
      .map(([key, work]) => ({ kind: "abandoned" as const, id: key.slice("event:".length), attempts: work.attempt + 1, event: work.event })),
    ...deadLetters.filter((letter) => !operator.checked[letter.id]),
  ];
  return {
    id, env, spec, operator, attention, events, queuedMessages,
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
      return send(res, 200, { env: o.env, agents: o.roster?.() ?? o.agents().map(({ id, spec }) => ({ id, role: spec.role })) });
    }
    const match = /^\/api\/agents\/([^/]+)(?:\/([a-z]+)(?:\/([^/]+))?)?$/.exec(path);
    // A malformed percent-escape names no agent: not found, not a server error.
    let id: string | undefined;
    try { id = match ? decodeURIComponent(match[1]) : undefined; } catch { id = undefined; }
    const item = id === undefined ? undefined : o.agents().find((candidate) => candidate.id === id);
    const entry = id === undefined ? undefined : o.roster?.().find((candidate) => candidate.id === id);
    if (!item && !entry) return send(res, 404, { error: "not found" });
    const [, , action, arg] = match ?? [];
    if (req.method === "POST" && action === "startup" && (arg === "retry" || arg === "cancel") && o.startup && entry) {
      const generation = field(await readJson(req), "generation");
      if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) return send(res, 400, { error: "generation must be a nonnegative safe integer" });
      if (generation !== entry.generation || !o.startup({ id: entry.id, generation, action: arg })) return send(res, 409, { error: "agent startup changed; refresh before trying again" });
      return send(res, 202, { accepted: true });
    }
    if (!item || (entry && entry.state !== "ready")) return send(res, 409, { error: "agent is not ready" });
    // This one-shot read is not drained by closeStreams, so a fetch racing a spec-save
    // reopen can transiently 500; Pi's serialized queue keeps storage safe.
    if (req.method === "GET" && !action) return send(res, 200, await view(o.env, item));
    if (req.method === "GET" && action === "stream" && arg === undefined) return watch(item, res);
    const controls = item.agent.operator;
    // Reading a body (or state) yields to a concurrent reopen. Never act through
    // controls captured before that transition, even if the replacement is ready.
    const stillReady = () => {
      const now = o.roster?.().find((candidate) => candidate.id === id);
      return (!entry || (now?.state === "ready" && now.generation === entry.generation))
        && o.agents().some((candidate) => candidate.id === id && candidate.agent.operator === controls);
    };
    if (req.method === "DELETE" && action === "messages" && arg !== undefined) {
      if (!validRequestId(arg)) return send(res, 400, { error: REQUEST_ID_PROBLEM });
      const result = await controls.withdraw(arg);
      switch (result) {
        case "withdrawn": return send(res, 204, "");
        case "already_placed": return send(res, 409, { error: "The agent already has this message." });
        case "not_found": return send(res, 404, { error: "Queued message not found." });
        default: { const exhaustive: never = result; throw new Error(`unknown withdraw result: ${exhaustive}`); }
      }
    }
    if (req.method === "DELETE" && action === "orders" && arg !== undefined) {
      if (!/^\d+$/.test(arg)) return send(res, 400, { error: "order index must be a whole number" });
      // The page sends the text it rendered, so a stale render cannot remove the wrong order.
      const expected = field(await readJson(req), "expect");
      if (typeof expected !== "string") return send(res, 400, { error: "expect must be the current order text" });
      if (!stillReady()) return send(res, 409, { error: "agent lifecycle changed; refresh before trying again" });
      if ((await controls.state()).orders[Number(arg)] !== expected) return send(res, 409, { error: "orders changed; refresh" });
      if (!stillReady()) return send(res, 409, { error: "agent lifecycle changed; refresh before trying again" });
      await controls.removeOrder(Number(arg));
      return send(res, 204, "");
    }
    if (req.method === "PUT" && action === "spec" && arg === undefined && item.saveSpec) {
      let spec: AgentSpec;
      try { spec = parseAgentSpec(await readJson(req)); }
      catch (error) { return send(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      if (!stillReady()) return send(res, 409, { error: "agent lifecycle changed; refresh before trying again" });
      await item.saveSpec(spec);
      return send(res, 204, "");
    }
    if (req.method !== "POST") return send(res, 404, { error: "not found" });
    if (action === "steer" && arg !== undefined) {
      if (!validRequestId(arg)) return send(res, 400, { error: REQUEST_ID_PROBLEM });
      const result = await controls.steer(arg);
      switch (result) {
        case "steered": return send(res, 204, "");
        case "already_placed": return send(res, 409, { error: "The agent already has this message." });
        case "not_found": return send(res, 404, { error: "Queued message not found." });
        default: { const exhaustive: never = result; throw new Error(`unknown steer result: ${exhaustive}`); }
      }
    }
    if (arg !== undefined) return send(res, 404, { error: "not found" });
    const body = await readJson(req);
    if (!stillReady()) return send(res, 409, { error: "agent lifecycle changed; refresh before trying again" });
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
    let dirty = false;
    let sending = Promise.resolve();
    const push = () => {
      // A read is already queued or running; its loop picks this commit up.
      if (dirty) return;
      dirty = true;
      sending = sending.then(async () => {
        while (dirty && !res.writableEnded) {
          dirty = false;
          const data = JSON.stringify(await view(o.env, item));
          // A stalled reader only fills its socket buffer: end the stream rather than buffer views forever.
          if (res.writableLength > MAX_BUFFERED_BYTES) return end();
          if (data === last || res.writableEnded) continue;
          last = data;
          res.write(`event: view\ndata: ${data}\n\n`);
        }
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
  // already under way, so none reads an agent's store after it starts to close. Awaiting
  // settled() deliberately waits out in-flight view reads, including CLI children bounded
  // by runCli's timeout.
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
