import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openMarketplaceAgent } from "../src/core/agent.js";
import type { CliResult } from "../src/core/cli.js";
import { initialOperator } from "../src/core/operator.js";
import { runAgents, type AgentHandle, type RunOptions } from "../src/run.js";

const ROOT = join(import.meta.dirname, "..");
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });

// Agent folders with a valid agent file and an (empty) TaskFast config each.
function folders(...ids: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "console-host-"));
  dirs.push(dir);
  for (const id of ids) {
    mkdirSync(join(dir, id, ".taskfast"), { recursive: true });
    writeFileSync(join(dir, id, "agent.json"), readFileSync(join(ROOT, "examples", "brisk-poster.json")));
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
      state: async () => initialOperator(), events: async () => ({}),
      setFrozen: async () => {}, setPaused: async () => {}, message: async () => {}, addOrder: async () => {}, removeOrder: async () => {}, markChecked: async () => {}, retryEvent: async () => {},
    },
  };
}
// Runs the host until `body` finishes, then stops it.
async function host(options: Partial<RunOptions> & { agentsDir: string }, body: (link: URL | undefined, calls: string[]) => Promise<void>) {
  const stop = new AbortController();
  const lines: string[] = [];
  const calls: string[] = [];
  let ready = () => {};
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const running = runAgents({
    env: "local", signal: stop.signal, pingEveryMs: 60_000,
    openAgent: async ({ id }) => (calls.push(`open ${id}`), handle(id, calls)),
    listen: () => ({ close: async () => {} }),
    log: (line) => { lines.push(line); if (line.startsWith("running ")) ready(); },
    ...options,
  });
  await started;
  const printed = lines.find((line) => line.startsWith("console: "));
  try { await body(printed ? new URL(printed.slice("console: ".length)) : undefined, calls); }
  finally { stop.abort(); await running; }
}
const put = (link: URL, path: string, body: unknown) => fetch(new URL(path, link), {
  method: "PUT", body: JSON.stringify(body),
  headers: { authorization: `Bearer ${link.hash.slice("#token=".length)}`, "content-type": "application/json" },
});
const get = (link: URL, path: string) => fetch(new URL(path, link), { headers: { authorization: `Bearer ${link.hash.slice("#token=".length)}` } });

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
    const invalid = await put(link!, "/api/agents/me/spec", { ...JSON.parse(before), extra: true });
    expect(invalid.status).toBe(400);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(calls).toEqual(["open me", "open you"]);

    const changed = { ...JSON.parse(before), limits: { perJobUsd: 20, dailyUsd: 80 } };
    expect((await put(link!, "/api/agents/me/spec", changed)).status).toBe(204);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(changed);
    expect(calls).toEqual(["open me", "open you", "close me", "open me"]);
    const view = await (await get(link!, "/api/agents/me")).json() as { spec: { limits: unknown } };
    expect(view.spec.limits).toEqual({ perJobUsd: 20, dailyUsd: 80 });
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

it("streams a real store's commits, and closes its streams before the store at reopen and shutdown", async () => {
  const dir = folders("me");
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("Nothing yet.")));
  const order: string[] = [];
  await host({
    agentsDir: dir, console: { port: 0 },
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
    const live = await views(link!, "/api/agents/me/stream");
    expect(await live.next()).toMatchObject({ operator: { paused: false } });
    const paused = await fetch(new URL("/api/agents/me/paused", link), { method: "POST", body: JSON.stringify({ value: true }), headers: { authorization: `Bearer ${link!.hash.slice(7)}`, "content-type": "application/json" } });
    expect(paused.status).toBe(204);
    let view = await live.next();
    while (view !== "ended" && !view.operator.paused) view = await live.next();
    expect(view).toMatchObject({ operator: { paused: true } });

    expect((await put(link!, "/api/agents/me/spec", JSON.parse(readFileSync(join(dir, "me", "agent.json"), "utf8")))).status).toBe(204);
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
    const spec = JSON.parse(readFileSync(join(dir, "me", "agent.json"), "utf8"));
    const failed = await put(link!, "/api/agents/me/spec", spec);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: expect.stringContaining("store is already owned") });
    const listed = await (await get(link!, "/api/agents")).json() as { agents: { id: string }[] };
    expect(listed.agents.map((agent) => agent.id)).toEqual(["you"]);
  });
});

it("refuses a spec whose provider cannot be built, touching neither the file nor the running agent", async () => {
  const dir = folders("me", "you");
  const file = join(dir, "me", "agent.json");
  const before = readFileSync(file, "utf8");
  await host({ agentsDir: dir, console: { port: 0 } }, async (link, calls) => {
    await put(link!, "/api/agents/me/spec", { ...JSON.parse(before), model: "nosuch:some-model" });
    expect(readFileSync(file, "utf8")).toBe(before);
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
    await put(link!, "/api/agents/me/spec", JSON.parse(readFileSync(join(dir, "me", "agent.json"), "utf8")));
    expect(seen).toEqual([undefined, join(dir, "me", ".taskfast", "wallet-password")]);
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
