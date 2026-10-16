import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PING_MS } from "../src/console.js";
import { openMarketplaceAgent, type EventWork } from "../src/core/agent.js";
import type { CliResult } from "../src/core/cli.js";
import { CleanupError } from "../src/core/cleanup-error.js";
import { openAgentStorage } from "../src/core/storage.js";
import { initialOperator } from "../src/core/operator.js";
import type { Action } from "../src/core/policy.js";
import type { MarketEvent } from "../src/core/types.js";
import { runAgents, type AgentHandle, type RunOptions } from "../src/run.js";
import { copyExample, example } from "./example.js";

const ROOT = join(import.meta.dirname, "..");
const dirs: string[] = [];
const releases: (() => void)[] = [];
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });

// Agent folders with a valid agent file and an (empty) TaskFast config each.
function folders(...ids: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "console-host-"));
  dirs.push(dir);
  for (const id of ids) {
    mkdirSync(join(dir, id, ".taskfast"), { recursive: true });
    copyExample("brisk-poster", join(dir, id));
    writeFileSync(join(dir, id, ".taskfast", "config.json"), "{}");
  }
  return dir;
}
// A handle with the console's controls; records lifecycle calls by agent id.
function handle(id: string, calls: string[]): AgentHandle {
  return {
    closed: Promise.resolve({ reason: "closed" }),
    deliver: async () => {},
    ping: async () => {},
    close: async () => void calls.push(`close ${id}`),
    status: async () => ({ identity: { env: "local", agentId: "33333333-3333-4333-8333-333333333333" }, actions: {}, spend: {}, memory: [] }),
    transcript: async () => [],
    changes: () => () => {},
    operator: {
      state: async () => initialOperator(), events: async () => ({}), queued: async () => [], steer: async () => "not_found", withdraw: async () => "not_found",
      setFrozen: async () => {}, setPaused: async () => {}, message: async () => {}, addOrder: async () => {}, removeOrder: async () => {}, markChecked: async () => {}, retryEvent: async () => {},
    },
  };
}
// A handle whose policy actions and admitted events the test sets, announcing each change as a commit.
function moving(id: string) {
  const actions: Record<string, Action> = {};
  const events: Record<string, EventWork> = {};
  const listeners = new Set<() => void>();
  const base = handle(id, []);
  const agent: AgentHandle = {
    ...base,
    status: async () => ({ ...(await base.status!()), actions }),
    operator: { ...base.operator!, events: async () => events },
    changes: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { agent, actions, events, commit: () => listeners.forEach((listener) => listener()) };
}
const action = (status: Action["status"], amount: number): Action => ({ status, amount, at: "2026-10-15T08:00:00Z", day: "2026-10-15" });
const admitted = (eventId: string, event: string): EventWork => ({ kind: "admitted", event: { event_id: eventId, event }, attempt: 0 });
// A wallet read that answers, after `delayMs`, with how many reads have started, and
// records the most ever running at once. `before` runs as each read starts.
function balanceRead(delayMs = 0, before = () => {}) {
  const counts = { reads: 0, running: 0, most: 0 };
  const command = async (_runtime: unknown, args: string[]): Promise<CliResult> => {
    if (args[0] !== "wallet") return { outcome: "failed", error: "unexpected read" };
    before();
    const balance = String(++counts.reads);
    counts.most = Math.max(counts.most, ++counts.running);
    try { await sleep(delayMs); }
    finally { counts.running--; }
    return { outcome: "ok", data: { balance: { available_balance: balance } } };
  };
  return { command, counts };
}
const shown = (view: unknown) => (view as { host: { wallet?: { balance: { available_balance: string } } } }).host?.wallet?.balance.available_balance;
// Runs the host until `body` finishes, then stops it.
async function host(options: Partial<RunOptions> & { agentsDir: string }, body: (link: URL | undefined, calls: string[], lines: string[]) => Promise<void>) {
  const stop = new AbortController();
  const lines: string[] = [];
  const calls: string[] = [];
  let ready = () => {};
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const running = runAgents({
    env: "local", signal: stop.signal, pingEveryMs: 60_000,
    command: async () => ({ outcome: "failed", error: "synthetic offline host" }),
    openAgent: async ({ id }) => (calls.push(`open ${id}`), handle(id, calls)),
    listen: () => ({ close: async () => {} }),
    log: (line) => { lines.push(line); if (line.startsWith("running ")) ready(); },
    ...options,
  });
  await Promise.race([started, running]);
  const printed = lines.find((line) => line.startsWith("console: "));
  try { await body(printed ? new URL(printed.slice("console: ".length)) : undefined, calls, lines); }
  finally { stop.abort(); releases.splice(0).forEach((release) => release()); await running; }
}
const put = (link: URL, path: string, body: unknown) => fetch(new URL(path, link), {
  method: "PUT", body: JSON.stringify(body),
  headers: { authorization: `Bearer ${link.hash.slice("#token=".length)}`, "content-type": "application/json" },
});
const get = (link: URL, path: string) => fetch(new URL(path, link), { headers: { authorization: `Bearer ${link.hash.slice("#token=".length)}` } });
const balance = async (link: URL) => shown(await (await get(link, "/api/agents/me")).json());
const startup = (link: URL, id: string, action: "retry" | "cancel", generation: number) => fetch(new URL(`/api/agents/${id}/startup/${action}`, link), {
  method: "POST", body: JSON.stringify({ generation }),
  headers: { authorization: `Bearer ${link.hash.slice(7)}`, "content-type": "application/json" },
});
type RosterRow = { id: string; generation: number; state: string; phase?: string; reason?: string };
const roster = async (link: URL): Promise<RosterRow[]> => ((await (await get(link, "/api/agents")).json()) as { agents: RosterRow[] }).agents;
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}

it("serves the console and pings a healthy sibling while another opening is hung", async () => {
  const opening = gate();
  const calls: string[] = [];
  let signal: AbortSignal | undefined;
  try {
    await host({
      agentsDir: folders("a", "b"), console: { port: 0 },
      openAgent: async (options) => {
        if (options.id === "a") { signal = options.signal; await opening.promise; }
        return { ...handle(options.id, calls), ping: async () => { calls.push(`ping ${options.id}`); } };
      },
    }, async (link) => {
      expect(await roster(link!)).toMatchObject([{ id: "a", state: "starting", phase: "opening" }, { id: "b", state: "ready" }]);
      expect(calls).toContain("ping b");
      expect((await get(link!, "/api/agents/b")).status).toBe(200);
      expect((await startup(link!, "a", "cancel", 1)).status).toBe(202);
      expect(signal?.aborted).toBe(true);
      expect(await roster(link!)).toMatchObject([{ id: "a", state: "stopped" }, { id: "b", state: "ready" }]);
      opening.release();
      await expect.poll(() => calls).toContain("close a");
      expect(calls).not.toContain("ping a");
    });
  } finally { opening.release(); }
});

it("keeps malformed agents visible and the console alive when all agents stop", async () => {
  const dir = folders("a", "b");
  writeFileSync(join(dir, "a", "agent.json"), "not JSON");
  await host({ agentsDir: dir, console: { port: 0 } }, async (link) => {
    expect(await roster(link!)).toMatchObject([{ id: "a", state: "stopped", reason: expect.any(String) }, { id: "b", state: "ready" }]);
    expect((await get(link!, "/api/agents/b")).status).toBe(200);
  });
  await host({ agentsDir: dir, console: { port: 0 }, openAgent: async () => { throw new Error("offline"); } }, async (link) => {
    expect((await roster(link!)).every((entry) => entry.state === "stopped")).toBe(true);
  });
});

it("never publishes JSON parser snippets from a malformed private config", async () => {
  const dir = folders("me");
  const secret = "synthetic-private-token-not-for-display";
  writeFileSync(join(dir, "me", ".taskfast", "config.json"), `not-json-${secret}`);
  await host({ agentsDir: dir, console: { port: 0 } }, async (link, calls, lines) => {
    const rows = await roster(link!);
    expect(rows).toMatchObject([{ id: "me", state: "stopped", reason: "me: cannot read .taskfast/config.json as JSON" }]);
    expect(calls).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(secret);
    expect((await get(link!, "/")).status).toBe(200);
  });
});

it("scopes retry to a generation, waits for late-result cleanup, and re-reads files", async () => {
  const dir = folders("me");
  const opening = gate();
  const closing = gate();
  const calls: string[] = [];
  let opens = 0;
  try {
    await host({ agentsDir: dir, console: { port: 0 }, openAgent: async ({ id, spec }) => {
      calls.push(`open ${spec.instructions}`);
      if (++opens === 1) {
        await opening.promise;
        return { ...handle(id, calls), close: async () => { calls.push("closing"); await closing.promise; calls.push("closed"); } };
      }
      return handle(id, calls);
    } }, async (link) => {
      expect((await startup(link!, "me", "cancel", 1)).status).toBe(202);
      expect((await startup(link!, "me", "cancel", 1)).status).toBe(409);
      const cancelled = (await roster(link!))[0];
      expect((await startup(link!, "me", "retry", cancelled.generation)).status).toBe(202);
      expect((await startup(link!, "me", "retry", cancelled.generation)).status).toBe(409);
      expect((await roster(link!))[0]).toMatchObject({ state: "starting", phase: "waiting-for-close" });
      opening.release();
      await expect.poll(() => calls).toContain("closing");
      expect(opens).toBe(1);
      writeFileSync(join(dir, "me", "INSTRUCTIONS.md"), "You are the fresh configuration.");
      closing.release();
      await expect.poll(async () => (await roster(link!))[0].state).toBe("ready");
      expect(calls.slice(-2)).toEqual(["closed", "open You are the fresh configuration."]);
      expect((await startup(link!, "me", "cancel", 1)).status).toBe(409);
      expect((await startup(link!, "me", "retry", cancelled.generation)).status).toBe(409);
      expect((await roster(link!))[0].state).toBe("ready");
    });
  } finally { opening.release(); closing.release(); }
});

it("blocks retries after a cancelled late result fails to close", async () => {
  const opening = gate();
  let opens = 0;
  await host({ agentsDir: folders("me"), console: { port: 0 }, openAgent: async ({ id }) => {
    opens++;
    await opening.promise;
    return { ...handle(id, []), close: async () => { throw new Error("cleanup failed"); } };
  } }, async (link) => {
    expect((await startup(link!, "me", "cancel", 1)).status).toBe(202);
    const cancelled = (await roster(link!))[0];
    expect((await startup(link!, "me", "retry", cancelled.generation)).status).toBe(202);
    opening.release();
    await expect.poll(async () => (await roster(link!))[0].state).toBe("stopped");
    const failed = (await roster(link!))[0];
    expect(failed.reason).toContain("cleanup failed");
    expect((await startup(link!, "me", "retry", failed.generation)).status).toBe(409);
    expect(opens).toBe(1);
  });
});

it("blocks future retries when opening rejects with a cleanup failure", async () => {
  const failure = new CleanupError(new Error("synthetic cleanup failure"));
  let opens = 0;
  await host({ agentsDir: folders("me"), console: { port: 0 }, openAgent: async () => {
    opens++;
    throw failure;
  } }, async (link) => {
    await expect.poll(async () => (await roster(link!))[0].state).toBe("stopped");
    const failed = (await roster(link!))[0];
    expect(failed.reason).toBe(failure.message);
    expect((await startup(link!, "me", "retry", failed.generation)).status).toBe(409);
    expect(opens).toBe(1);
  });
});

it.each([false, true])("preserves an opening cleanup failure after cancellation (queued retry: %s)", async (queuedRetry) => {
  const opening = gate();
  const dir = folders("me");
  const storePath = join(dir, "me", ".pi-state", "local", "state.sqlite");
  const storage = await openAgentStorage(storePath);
  const models = createModels();
  models.setProvider(fauxProvider({ models: [{ id: "test" }] }).provider);
  const close = vi.fn(async () => { throw new Error("synthetic private cleanup detail"); });
  let opens = 0;
  let storageRequested = false;
  try {
    await host({ agentsDir: dir, console: { port: 0 }, openAgent: async (options) => {
      opens++;
      return openMarketplaceAgent({
        ...options, spec: { ...options.spec, model: "faux:test" }, models,
        command: async () => { throw new Error("cancelled opening must not contact the marketplace"); },
        openStorage: async () => {
          storageRequested = true;
          await opening.promise;
          return new Proxy(storage, { get(target, key) {
            if (key === "close") return close;
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          } });
        },
      });
    } }, async (link, _calls, lines) => {
      await expect.poll(() => storageRequested).toBe(true);
      expect(opens).toBe(1);
      expect((await startup(link!, "me", "cancel", 1)).status).toBe(202);
      const cancelled = (await roster(link!))[0];
      if (queuedRetry) expect((await startup(link!, "me", "retry", cancelled.generation)).status).toBe(202);
      opening.release();
      await expect.poll(async () => (await roster(link!))[0].reason).toContain("cleanup failed");
      const failed = (await roster(link!))[0];
      expect(failed.state).toBe("stopped");
      expect((await startup(link!, "me", "retry", failed.generation)).status).toBe(409);
      expect(opens).toBe(1);
      expect(close).toHaveBeenCalledOnce();
      await expect(openAgentStorage(storePath)).rejects.toThrow("already owned");
      expect(lines.join("\n")).not.toContain("synthetic private cleanup detail");
    });
  } finally {
    opening.release();
    await storage.close(BACKGROUND_CONTEXT);
  }
  // Test cleanup releases the retained real ownership lock, not the failed opener.
  const reopened = await openAgentStorage(storePath);
  await reopened.close(BACKGROUND_CONTEXT);
});

it("restores both Briefing files when shutdown interrupts old-owner cleanup", async () => {
  const closing = gate();
  const stop = new AbortController();
  const dir = folders("me");
  const file = join(dir, "me", "agent.json");
  const instructions = join(dir, "me", "INSTRUCTIONS.md");
  const before = { file: readFileSync(file, "utf8"), instructions: readFileSync(instructions, "utf8") };
  let opens = 0;
  try {
    await host({ agentsDir: dir, console: { port: 0 }, signal: stop.signal, openAgent: async ({ id }) => {
      opens++;
      return { ...handle(id, []), close: async () => { await closing.promise; } };
    } }, async (link) => {
      try {
        const saving = put(link!, "/api/agents/me/spec", {
          ...example("brisk-poster"), instructions: "You are a replacement that never opens.", limits: { perJobUsd: 1, dailyUsd: 2 },
        }).then((response) => response.status, () => "disconnected");
        await expect.poll(async () => (await roster(link!))[0].phase).toBe("waiting-for-close");
        expect(readFileSync(file, "utf8")).not.toBe(before.file);
        expect(readFileSync(instructions, "utf8")).not.toBe(before.instructions);
        stop.abort();
        closing.release();
        expect(await saving).not.toBe(204);
      } finally { stop.abort(); closing.release(); }
    });
  } finally { stop.abort(); closing.release(); }
  expect(readFileSync(file, "utf8")).toBe(before.file);
  expect(readFileSync(instructions, "utf8")).toBe(before.instructions);
  expect(opens).toBe(1);
});

it("serializes duplicate Briefing saves and startup intents through cleanup and rollback", async () => {
  const closing = gate();
  const dir = folders("me");
  let opens = 0;
  await host({ agentsDir: dir, console: { port: 0 }, openAgent: async ({ id }) => {
    opens++;
    return { ...handle(id, []), close: async () => { await closing.promise; } };
  } }, async (link) => {
    const first = put(link!, "/api/agents/me/spec", { ...example("brisk-poster"), instructions: "You are the first save." });
    await expect.poll(async () => (await roster(link!))[0].phase).toBe("waiting-for-close");
    const starting = (await roster(link!))[0];
    expect((await startup(link!, "me", "cancel", starting.generation)).status).toBe(409);
    expect((await startup(link!, "me", "retry", starting.generation)).status).toBe(409);
    expect((await put(link!, "/api/agents/me/spec", { ...example("brisk-poster"), instructions: "You are a conflicting save." })).status).not.toBe(204);
    closing.release();
    expect((await first).status).toBe(204);
    expect(opens).toBe(2);
    expect(readFileSync(join(dir, "me", "INSTRUCTIONS.md"), "utf8")).toBe("You are the first save.");
  });
});

it("does not reuse an old generation's enrichment after reopening", async () => {
  const reading = gate();
  let reads = 0;
  await host({ agentsDir: folders("me"), console: { port: 0 }, command: async () => {
    const read = ++reads;
    if (read === 1) await reading.promise;
    return { outcome: "ok", data: { balance: { available_balance: String(read) } } };
  } }, async (link) => {
    expect(await balance(link!)).toBeUndefined();
    const saving = put(link!, "/api/agents/me/spec", example("brisk-poster"));
    await expect.poll(async () => (await roster(link!))[0].phase).toBe("waiting-for-close");
    reading.release();
    expect((await saving).status).toBe(204);
    expect(await balance(link!)).toBeUndefined();
    await expect.poll(() => balance(link!)).toBe("2");
    expect(reads).toBe(2);
  });
});

it("returns local facts while remote enrichment is hung", async () => {
  const reading = gate();
  try {
    await host({ agentsDir: folders("me"), console: { port: 0 }, command: async () => {
      await reading.promise;
      return { outcome: "ok", data: { balance: { available_balance: "7" } } };
    } }, async (link) => {
      const response = await get(link!, "/api/agents/me");
      expect(response.status).toBe(200);
      const view = await response.json() as { host: { wallet?: unknown; tasks: unknown; unlockFile: boolean } };
      expect(view.host).toMatchObject({ tasks: {}, unlockFile: false });
      expect(view.host.wallet).toBeUndefined();
      reading.release();
      await expect.poll(() => balance(link!)).toBe("7");
    });
  } finally { reading.release(); }
});

it("opens a console only when asked, and prints its one link", async () => {
  await host({ agentsDir: folders("me") }, async (link) => { expect(link).toBeUndefined(); });
  await host({ agentsDir: folders("me", "you"), console: { port: 0 } }, async (link) => {
    expect(link?.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(link?.hash).toMatch(/^#token=[0-9a-f]{64}$/);
    const listed = await (await get(link!, "/api/agents")).json();
    expect(listed).toMatchObject({ env: "local", agents: [{ id: "me" }, { id: "you" }] });
  });
});

it("saves a valid agent file and reopens only that agent; an invalid one changes nothing", async () => {
  const dir = folders("me", "you");
  const file = join(dir, "me", "agent.json");
  const before = readFileSync(file, "utf8");
  await host({ agentsDir: dir, console: { port: 0 } }, async (link, calls) => {
    const invalid = await put(link!, "/api/agents/me/spec", { ...example("brisk-poster"), extra: true });
    expect(invalid.status).toBe(400);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(calls).toEqual(["open me", "open you"]);

    expect((await put(link!, "/api/agents/me/spec", JSON.parse(before))).status).toBe(400);
    expect(calls).toEqual(["open me", "open you"]);

    const instructions = "You are Mo, who runs Mo's Prints.\n\nWhat you want right now: hire one poster designer.\n";
    const changed = { ...JSON.parse(before), limits: { perJobUsd: 20, dailyUsd: 80 } };
    expect((await put(link!, "/api/agents/me/spec", { ...changed, instructions })).status).toBe(204);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(changed);
    expect(readFileSync(join(dir, "me", "INSTRUCTIONS.md"), "utf8")).toBe(instructions);
    expect(calls).toEqual(["open me", "open you", "close me", "open me"]);
    const view = await (await get(link!, "/api/agents/me")).json() as { spec: { limits: unknown; instructions: string }; prompt: string };
    expect(view.spec).toMatchObject({ limits: { perJobUsd: 20, dailyUsd: 80 }, instructions });
    expect(view.prompt).toMatch(/^You are Mo, who runs Mo's Prints\./);
  });
});

it("adds what only the host knows: unlock file, stream, wallet, dead letters and task summaries", async () => {
  const dir = folders("me");
  const task = "11111111-1111-4111-8111-111111111111";
  writeFileSync(join(dir, "me", ".taskfast", "dead-letter.jsonl"), `${JSON.stringify({ at: "2026-10-13T08:00:00Z", reason: "no event name", line: JSON.stringify({ event_id: "bad-1" }) })}\n`);
  writeFileSync(join(dir, "me", ".taskfast", "wallet-password"), "x", { mode: 0o400 });
  const reads: string[][] = [];
  await host({
    agentsDir: dir, console: { port: 0 },
    listen: ({ log }) => (log("sentinel connected"), { close: async () => {} }),
    command: async (_runtime, args): Promise<CliResult> => {
      reads.push(args);
      if (args[0] === "wallet") return { outcome: "ok", data: { balance: { available_balance: "0x0" } } };
      if (args[0] === "task") return { outcome: "ok", data: { task: { id: task, title: "Edit a page", status: "open", budget_max: "15.00" } } };
      return { outcome: "failed", error: "unexpected read" };
    },
    openAgent: async ({ id }) => ({ ...handle(id, []), transcript: async () => [
      { role: "user", content: "Message from your operator:\nPost a job.", timestamp: 1 },
      fauxAssistantMessage([fauxToolCall("message_send", { task_id: task, content: "Hi" }, { id: "c1" })], { stopReason: "toolUse" }),
      { role: "toolResult", toolCallId: "c1", toolName: "message_send", content: [{ type: "text", text: "{}" }], isError: false, timestamp: 3 },
    ] }),
  }, async (link) => {
    await expect.poll(() => balance(link!)).toBe("0x0");
    const view = await (await get(link!, "/api/agents/me")).json() as { host: Record<string, unknown>; attention: unknown[] };
    expect(view.host).toMatchObject({
      unlockFile: true, stream: "connected",
      wallet: { balance: { available_balance: "0x0" } },
      tasks: { [task]: { task: { id: task, title: "Edit a page", status: "open", budget_max: "15.00" } } },
    });
    expect(view.attention).toContainEqual({ kind: "dead-letter", id: "dead-letter:bad-1", at: "2026-10-13T08:00:00Z", reason: "no event name", line: JSON.stringify({ event_id: "bad-1" }) });
    await get(link!, "/api/agents/me");
    expect(reads).toEqual([["wallet", "balance"], ["task", "get", "--", task]]);
  });
});

// Reads an event stream's `view` events, skipping pings.
async function views(link: URL, path: string) {
  const response = await fetch(new URL(path, link), { headers: { authorization: `Bearer ${link.hash.slice("#token=".length)}` } });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return {
    async next(): Promise<{ operator: { paused: boolean } } | "ended"> {
      for (;;) {
        const at = buffer.indexOf("\n\n");
        if (at >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (block.startsWith("event: view")) return JSON.parse(block.slice(block.indexOf("data: ") + 6));
          continue;
        }
        const { done, value } = await reader.read();
        if (done) return "ended";
        buffer += value;
      }
    },
  };
}

async function nextBalance(stream: Awaited<ReturnType<typeof views>>, wanted: string) {
  for (;;) {
    const view = await stream.next();
    if (view === "ended" || shown(view) === wanted) return view === "ended" ? view : shown(view);
  }
}

it("streams a real store's commits, and closes its streams before the store at reopen and shutdown", async () => {
  const dir = folders("me");
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("Nothing yet.")));
  const order: string[] = [];
  const wallet = balanceRead();
  let deliver: ((event: MarketEvent) => Promise<void>) | undefined;
  await host({
    agentsDir: dir, console: { port: 0 },
    command: wallet.command,
    listen: (options) => { deliver = options.deliver; return { close: async () => {} }; },
    openAgent: async ({ id, spec, runtime, storePath }) => {
      const agent = await openMarketplaceAgent({
        spec: { ...spec, model: "faux:test" }, runtime, storePath, models, recoverEveryMs: 60_000,
        command: async () => ({ outcome: "ok", data: { profile: { id: "33333333-3333-4333-8333-333333333333" } } }),
      });
      order.push(`open ${id}`);
      return {
        ...agent,
        changes: (listener) => { const off = agent.changes(listener); return () => { order.push(`unwatch ${id}`); off(); }; },
        close: async () => { order.push(`close ${id}`); await agent.close(); },
      };
    },
  }, async (link) => {
    await expect.poll(async () => (await roster(link!))[0].state).toBe("ready");
    const live = await views(link!, "/api/agents/me/stream");
    expect(await live.next()).toMatchObject({ operator: { paused: false } });
    const paused = await fetch(new URL("/api/agents/me/paused", link), { method: "POST", body: JSON.stringify({ value: true }), headers: { authorization: `Bearer ${link!.hash.slice(7)}`, "content-type": "application/json" } });
    expect(paused.status).toBe(204);
    let view = await live.next();
    while (view !== "ended" && !view.operator.paused) view = await live.next();
    expect(view).toMatchObject({ operator: { paused: true } });
    expect(shown(view)).toBe("1");

    // A payment the stream admits into the real store refreshes the shown balance without a reload.
    await deliver!({ event_id: "pay-1", event: "payment_released", data: {} });
    view = await live.next();
    while (view !== "ended" && shown(view) !== "2") view = await live.next();
    expect(shown(view)).toBe("2");
    expect(wallet.counts.reads).toBe(2);

    expect((await put(link!, "/api/agents/me/spec", example("brisk-poster"))).status).toBe(204);
    while (await live.next() !== "ended");
    expect(order).toEqual(["open me", "unwatch me", "close me", "open me"]);
    await views(link!, "/api/agents/me/stream").then((again) => again.next());
  });
  expect(order).toEqual(["open me", "unwatch me", "close me", "open me", "unwatch me", "close me"]);
});

it("keeps the host running when an agent cannot reopen", async () => {
  const dir = folders("me", "you");
  let opens = 0;
  await host({
    agentsDir: dir, console: { port: 0 },
    openAgent: async ({ id }) => {
      if (id === "me" && ++opens > 1) throw new Error("store is already owned");
      return handle(id, []);
    },
  }, async (link) => {
    const before = { file: readFileSync(join(dir, "me", "agent.json"), "utf8"), instructions: readFileSync(join(dir, "me", "INSTRUCTIONS.md"), "utf8") };
    const failed = await put(link!, "/api/agents/me/spec", { ...example("brisk-poster"), instructions: "You are someone new.\n", dials: { competence: 0.1, diligence: 0.1, priceSensitivity: 0.1, temperament: "curt" } });
    expect(failed.status).toBe(500);
    // Both files go back to what they were, so the next host start loads the old agent.
    expect(readFileSync(join(dir, "me", "agent.json"), "utf8")).toBe(before.file);
    expect(readFileSync(join(dir, "me", "INSTRUCTIONS.md"), "utf8")).toBe(before.instructions);
    expect(await failed.json()).toMatchObject({ error: expect.stringContaining("store is already owned") });
    expect(await roster(link!)).toMatchObject([{ id: "me", state: "stopped", reason: "store is already owned" }, { id: "you", state: "ready" }]);
  });
});

it("refuses a spec whose provider cannot be built, touching neither the file nor the running agent", async () => {
  const dir = folders("me", "you");
  const file = join(dir, "me", "agent.json");
  const before = readFileSync(file, "utf8");
  await host({ agentsDir: dir, console: { port: 0 } }, async (link, calls) => {
    await put(link!, "/api/agents/me/spec", { ...example("brisk-poster"), instructions: "You are someone new.\n", model: "nosuch:some-model" });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readFileSync(join(dir, "me", "INSTRUCTIONS.md"), "utf8")).toBe(example("brisk-poster").instructions);
    expect(calls).toEqual(["open me", "open you"]);
    const listed = await (await get(link!, "/api/agents")).json() as { agents: { id: string }[] };
    expect(listed.agents.map((agent) => agent.id)).toEqual(["me", "you"]);
    const view = await (await get(link!, "/api/agents/me")).json() as { spec: { model: string } };
    expect(view.spec.model).toBe("anthropic:claude-haiku-5-5");
  });
});

it("skips dead-letter lines that are not records of string at, reason and line", async () => {
  const dir = folders("me");
  writeFileSync(join(dir, "me", ".taskfast", "dead-letter.jsonl"), [
    JSON.stringify({ at: "2026-10-13T08:00:00Z", reason: "no event name", line: JSON.stringify({ event_id: "bad-1" }) }),
    "null",
    JSON.stringify(["not", "a", "record"]),
    JSON.stringify({ at: "2026-10-13T09:00:00Z", reason: 42, line: "{}" }),
  ].join("\n") + "\n");
  await host({
    agentsDir: dir, console: { port: 0 },
    command: async (): Promise<CliResult> => ({ outcome: "ok", data: null }),
  }, async (link) => {
    const view = await (await get(link!, "/api/agents/me")).json() as { host?: Record<string, unknown>; attention: Record<string, unknown>[] };
    // A parseable non-record line must not take the whole agent view down.
    expect(view.host).toBeDefined();
    expect(view.attention.filter((entry) => entry.kind === "dead-letter")).toEqual([
      { kind: "dead-letter", id: "dead-letter:bad-1", at: "2026-10-13T08:00:00Z", reason: "no event name", line: JSON.stringify({ event_id: "bad-1" }) },
    ]);
  });
});

it("discovers an unlock file created after start, in facts and in the reopen runtime", async () => {
  const dir = folders("me");
  const seen: (string | undefined)[] = [];
  await host({
    agentsDir: dir, console: { port: 0 },
    command: async (): Promise<CliResult> => ({ outcome: "ok", data: null }),
    openAgent: async ({ id, runtime }) => (seen.push(runtime.walletPasswordFile), handle(id, [])),
  }, async (link) => {
    expect((await (await get(link!, "/api/agents/me")).json() as { host: { unlockFile: boolean } }).host.unlockFile).toBe(false);
    writeFileSync(join(dir, "me", ".taskfast", "wallet-password"), "x", { mode: 0o400 });
    expect((await (await get(link!, "/api/agents/me")).json() as { host: { unlockFile: boolean } }).host.unlockFile).toBe(true);
    await put(link!, "/api/agents/me/spec", example("brisk-poster"));
    expect(seen).toEqual([undefined, join(dir, "me", ".taskfast", "wallet-password")]);
  });
});

it("re-reads the wallet once a money tool settles ok or uncertain, never after a refusal", async () => {
  const me = moving("me");
  const wallet = balanceRead();
  await host({ agentsDir: folders("me"), console: { port: 0 }, openAgent: async () => me.agent, command: wallet.command }, async (link) => {
    await expect.poll(() => balance(link!)).toBe("1");
    me.actions["escrow:b1"] = action("reserved", 40);
    expect(await balance(link!)).toBe("1");
    me.actions["escrow:b1"] = action("failed", 40);
    expect(await balance(link!)).toBe("1");
    me.actions["accept:b1"] = action("done", 0);
    expect(await balance(link!)).toBe("1");
    me.actions["escrow:b1"] = action("done", 40);
    await expect.poll(() => balance(link!)).toBe("2");
    expect(await balance(link!)).toBe("2");
    me.actions["post:p1"] = action("uncertain", 1);
    await expect.poll(() => balance(link!)).toBe("3");
    expect(wallet.counts.reads).toBe(3);
  });
});

it("shares one wallet read among open streams and folds a burst of payment events into one", async () => {
  const me = moving("me");
  const wallet = balanceRead(30);
  await host({ agentsDir: folders("me"), console: { port: 0 }, openAgent: async () => me.agent, command: wallet.command }, async (link) => {
    const streams = await Promise.all([1, 2, 3].map(() => views(link!, "/api/agents/me/stream")));
    expect(await Promise.all(streams.map((stream) => nextBalance(stream, "1")))).toEqual(["1", "1", "1"]);
    expect(wallet.counts.reads).toBe(1);

    for (let n = 1; n <= 5; n++) {
      me.events[`event:pay-${n}`] = admitted(`pay-${n}`, n % 2 ? "payment_released" : "payment_disbursed");
      me.commit();
    }
    expect(await Promise.all(streams.map((stream) => nextBalance(stream, "2")))).toEqual(["2", "2", "2"]);
    expect(wallet.counts.reads).toBe(2);

    // Asking for a signature moves nothing.
    me.events["event:sign-1"] = admitted("sign-1", "payment_signature_required");
    me.commit();
    expect(await balance(link!)).toBe("2");
    expect(wallet.counts).toMatchObject({ reads: 2, most: 1 });
  });
});

it("reads the wallet once more after an in-flight read when money moves during it, never two at once", async () => {
  const me = moving("me");
  let during: Promise<unknown> | undefined;
  let link: URL | undefined;
  const wallet = balanceRead(30, () => {
    if (wallet.counts.reads > 0) return;
    me.events["event:pay-1"] = admitted("pay-1", "payment_held");
    during = balance(link!);
  });
  await host({ agentsDir: folders("me"), console: { port: 0 }, openAgent: async () => me.agent, command: wallet.command }, async (given) => {
    link = given;
    expect(await balance(link!)).toBeUndefined();
    expect(await during).toBeUndefined();
    await expect.poll(() => balance(link!)).toBe("2");
    expect(wallet.counts).toMatchObject({ reads: 2, most: 1 });
  });
});

it("keeps the wallet for just under one ping interval and task reads for a minute", async () => {
  const task = "11111111-1111-4111-8111-111111111111";
  const reads: string[] = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    await host({
      agentsDir: folders("me"), console: { port: 0 },
      command: async (_runtime, args): Promise<CliResult> => (reads.push(args[0]), { outcome: "ok", data: null }),
      openAgent: async ({ id }) => ({ ...handle(id, []), transcript: async () => [
        { role: "user", content: "Message from your operator:\nPost a job.", timestamp: 1 },
        fauxAssistantMessage([fauxToolCall("message_send", { task_id: task, content: "Hi" }, { id: "c1" })], { stopReason: "toolUse" }),
        { role: "toolResult", toolCallId: "c1", toolName: "message_send", content: [{ type: "text", text: "{}" }], isError: false, timestamp: 3 },
      ] }),
    }, async (link) => {
      const start = Date.now();
      await get(link!, "/api/agents/me");
      expect(reads).toEqual(["wallet", "task"]);
      vi.setSystemTime(start + PING_MS - 1_001);
      await get(link!, "/api/agents/me");
      expect(reads).toEqual(["wallet", "task"]);
      vi.setSystemTime(start + PING_MS - 1_000);
      await get(link!, "/api/agents/me");
      expect(reads).toEqual(["wallet", "task", "wallet"]);
      vi.setSystemTime(start + 60_000);
      await get(link!, "/api/agents/me");
      expect(reads).toEqual(["wallet", "task", "wallet", "wallet", "task"]);
    });
  } finally { vi.useRealTimers(); }
});

it("does not keep a wallet read that threw", async () => {
  let reads = 0;
  await host({
    agentsDir: folders("me"), console: { port: 0 },
    command: async (): Promise<CliResult> => {
      if (++reads === 1) throw new Error("spawn failed");
      return { outcome: "ok", data: { balance: { available_balance: "0x5" } } };
    },
  }, async (link) => {
    expect((await get(link!, "/api/agents/me")).status).toBe(200);
    await expect.poll(() => balance(link!)).toBe("0x5");
    expect(reads).toBe(2);
  });
});

it("waits out a wallet read before closing the agent, and sends no view after its stream ends", async () => {
  const order: string[] = [];
  let release = () => {};
  await host({
    agentsDir: folders("me"), console: { port: 0 },
    openAgent: async ({ id }) => handle(id, order),
    command: async (): Promise<CliResult> => {
      order.push("read");
      await new Promise<void>((resolve) => { release = resolve; });
      order.push("read done");
      return { outcome: "ok", data: null };
    },
  }, async (link) => {
    const live = await views(link!, "/api/agents/me/stream");
    expect(shown(await live.next())).toBeUndefined();
    await expect.poll(() => order).toEqual(["read"]);
    const saving = put(link!, "/api/agents/me/spec", example("brisk-poster"));
    await sleep(50);
    expect(order).toEqual(["read"]);
    release();
    expect((await saving).status).toBe(204);
    expect(order).toEqual(["read", "read done", "close me"]);
    expect(await live.next()).toBe("ended");
  });
});

it("closes a half-opened agent whose listener cannot start", async () => {
  const dir = folders("me");
  const calls: string[] = [];
  await expect(runAgents({
    agentsDir: dir, env: "local", signal: new AbortController().signal, log: () => {},
    openAgent: async ({ id }) => (calls.push(`open ${id}`), handle(id, calls)),
    listen: () => { throw new Error("old CLI"); },
  })).rejects.toThrow("old CLI");
  expect(calls).toEqual(["open me", "close me"]);
});
