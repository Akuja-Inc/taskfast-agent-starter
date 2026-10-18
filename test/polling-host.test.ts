import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initialOperator } from "../src/core/operator.js";
import { runAgents, type AgentHandle, type RunOptions } from "../src/run.js";
import { copyExample, example } from "./example.js";

// Control only the host's sleep boundary, not its polling, ownership or file lifecycle.
// Vitest fake timers do not advance node:timers/promises.
const waits = vi.hoisted(() => [] as { ms: number; signal?: AbortSignal; wake(): void }[]);
vi.mock("node:timers/promises", async (original) => ({
  ...await original<typeof import("node:timers/promises")>(),
  setTimeout: (ms: number, _value: unknown, options?: { signal?: AbortSignal }) => new Promise<void>((resolve) => {
    const signal = options?.signal;
    const wake = () => { signal?.removeEventListener("abort", wake); resolve(); };
    waits.push({ ms, signal, wake });
    if (signal?.aborted) wake();
    else signal?.addEventListener("abort", wake, { once: true });
  }),
}));
const dirs: string[] = [];
afterEach(() => { waits.splice(0); dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
function folders(intervals: Record<string, number | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), "polling-host-"));
  dirs.push(dir);
  for (const [id, minutes] of Object.entries(intervals)) {
    mkdirSync(join(dir, id, ".taskfast"), { recursive: true });
    copyExample("careful-worker", join(dir, id));
    const { instructions: _, ...file } = example("careful-worker");
    writeFileSync(join(dir, id, "agent.json"), JSON.stringify({ ...file, pollIntervalMinutes: minutes }));
    writeFileSync(join(dir, id, ".taskfast", "config.json"), JSON.stringify({ environment: "local" }));
  }
  return dir;
}
async function launch(dir: string, options: Partial<RunOptions> = {}) {
  const stop = new AbortController();
  const calls: string[] = [];
  let printed = "";
  let ready = () => {};
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const generations = new Map<string, number>();
  const running = runAgents({
    agentsDir: dir, env: "local", signal: stop.signal, console: { port: 0 },
    command: async () => ({ outcome: "failed", error: "offline fixture" }),
    listen: () => ({ close: async () => {} }),
    openAgent: async ({ id }): Promise<AgentHandle> => {
      const generation = (generations.get(id) ?? 0) + 1;
      generations.set(id, generation);
      const key = `${id}:${generation}`;
      calls.push(`open ${key}`);
      return {
        closed: Promise.resolve({ reason: "closed" }), deliver: async () => {},
        ping: async () => { calls.push(`ping ${key}`); }, close: async () => { calls.push(`close ${key}`); },
        status: async () => ({ identity: { env: "local", agentId: "33333333-3333-4333-8333-333333333333" }, actions: {}, spend: {}, memory: [] }), transcript: async () => [], changes: () => () => {},
        operator: {
          state: async () => initialOperator(), events: async () => ({}), queued: async () => [],
          steer: async () => "not_found", withdraw: async () => "not_found",
          setFrozen: async () => {}, setPaused: async () => {}, message: async () => {}, addOrder: async () => {},
          removeOrder: async () => {}, replaceOrder: async () => {}, markChecked: async () => {}, retryEvent: async () => {},
        },
      };
    },
    log: (line) => { if (line.startsWith("console: ")) printed = line.slice(9); if (line.startsWith("running ")) ready(); },
    ...options,
  });
  await Promise.race([started, running]);
  const link = new URL(printed);
  const headers = { authorization: `Bearer ${link.hash.slice(7)}`, "content-type": "application/json" };
  return {
    calls,
    async view(id: string) { return (await fetch(new URL(`/api/agents/${id}`, link), { headers })).json(); },
    save(id: string, body: unknown) { return fetch(new URL(`/api/agents/${id}/spec`, link), { method: "PUT", headers, body: JSON.stringify(body) }); },
    close: async () => { stop.abort(); await running; },
  };
}

it("uses independent saved delays and the legacy default, starting each check immediately", async () => {
  const host = await launch(folders({ a: 1, b: 2, legacy: undefined }));
  try {
    await expect.poll(() => waits.length).toBe(3);
    expect(waits.map(({ ms }) => ms).sort((a, b) => a - b)).toEqual([60_000, 120_000, 900_000]);
    expect(host.calls.filter((call) => call.startsWith("ping"))).toEqual(["ping a:1", "ping b:1", "ping legacy:1"]);
    waits.find(({ ms }) => ms === 60_000)!.wake();
    await expect.poll(() => waits.length).toBe(4);
    expect(host.calls.filter((call) => call.startsWith("ping"))).toEqual(["ping a:1", "ping b:1", "ping legacy:1", "ping a:1"]);
    expect(waits[3].ms).toBe(60_000);
    expect(await host.view("legacy")).toMatchObject({ host: { pollIntervalMs: 900_000 } });
  } finally { await host.close(); }
  expect(waits.every(({ signal }) => signal?.aborted)).toBe(true);
});

it("waits for each ping to finish before starting its delay without blocking a sibling", async () => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const pings: string[] = [];
  const host = await launch(folders({ fast: 2, slow: 1 }), { openAgent: async ({ id }) => ({
    closed: Promise.resolve({ reason: "closed" }), deliver: async () => {}, close: async () => {},
    ping: async () => { pings.push(id); if (id === "slow") await pending; },
  }) });
  try {
    await expect.poll(() => waits.length).toBe(1);
    expect(waits[0].ms).toBe(120_000);
    waits[0].wake();
    await expect.poll(() => waits.length).toBe(2);
    expect(pings.filter((id) => id === "slow")).toHaveLength(1);
    expect(pings.filter((id) => id === "fast")).toHaveLength(2);
    release();
    await expect.poll(() => waits.length).toBe(3);
    expect(waits[2].ms).toBe(60_000);
  } finally { release(); await host.close(); }
});

it("keeps an explicit host override ahead of saved and default intervals", async () => {
  const host = await launch(folders({ a: 1, legacy: undefined }), { pingEveryMs: 17 });
  try {
    await expect.poll(() => waits.length).toBe(2);
    expect(waits.map(({ ms }) => ms)).toEqual([17, 17]);
    expect(await host.view("a")).toMatchObject({ spec: { pollIntervalMinutes: 1 }, host: { pollIntervalMs: 17 } });
  } finally { await host.close(); }
});

it("persists Settings saves, cancels only the replaced loop and reloads the interval after host restart", async () => {
  const dir = folders({ me: 1, you: 2 });
  let host = await launch(dir);
  try {
    await expect.poll(() => waits.length).toBe(2);
    const previous = waits.find(({ ms }) => ms === 60_000)!;
    const sibling = waits.find(({ ms }) => ms === 120_000)!;
    const before = readFileSync(join(dir, "me", "agent.json"), "utf8");
    expect((await host.save("me", { ...example("careful-worker"), pollIntervalMinutes: 0 })).status).toBe(400);
    expect(readFileSync(join(dir, "me", "agent.json"), "utf8")).toBe(before);
    expect(previous.signal?.aborted).toBe(false);
    expect((await host.save("me", { ...example("careful-worker"), pollIntervalMinutes: 3 })).status).toBe(204);
    await expect.poll(() => waits.length).toBe(3);
    expect(previous.signal?.aborted).toBe(true);
    expect(sibling.signal?.aborted).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "me", "agent.json"), "utf8"))).toHaveProperty("pollIntervalMinutes", 3);
    expect(await host.view("me")).toMatchObject({ spec: { pollIntervalMinutes: 3 }, host: { pollIntervalMs: 180_000 } });
    waits[2].wake();
    await expect.poll(() => waits.length).toBe(4);
    expect(host.calls.filter((call) => call.startsWith("ping"))).toEqual(["ping me:1", "ping you:1", "ping me:2", "ping me:2"]);
    expect(host.calls.filter((call) => !call.startsWith("ping"))).toEqual(["open me:1", "open you:1", "close me:1", "open me:2"]);
    await host.close();
    waits.splice(0);
    host = await launch(dir);
    await expect.poll(() => waits.length).toBe(2);
    expect(waits.map(({ ms }) => ms)).toEqual([180_000, 120_000]);
    expect(await host.view("me")).toMatchObject({ spec: { pollIntervalMinutes: 3 }, host: { pollIntervalMs: 180_000 } });
  } finally { await host.close(); }
});

it("restores the saved interval after a failed reopen without leaving the old loop running", async () => {
  const dir = folders({ me: 4 });
  const file = join(dir, "me", "agent.json");
  const instructions = join(dir, "me", "INSTRUCTIONS.md");
  const before = [readFileSync(file, "utf8"), readFileSync(instructions, "utf8")];
  let opens = 0;
  const failed = await launch(dir, { listen: () => {
    if (++opens > 1) throw new Error("fixture listener refused");
    return { close: async () => {} };
  } });
  try {
    await expect.poll(() => waits.length).toBe(1);
    const previous = waits[0];
    expect((await failed.save("me", { ...example("careful-worker"), instructions: "New instructions.", pollIntervalMinutes: 8 })).status).toBe(500);
    expect([readFileSync(file, "utf8"), readFileSync(instructions, "utf8")]).toEqual(before);
    expect(previous.signal?.aborted).toBe(true);
    expect(waits).toHaveLength(1);
    expect(failed.calls.filter((call) => call.startsWith("ping"))).toEqual(["ping me:1"]);
  } finally { await failed.close(); }
  waits.splice(0);
  const restored = await launch(dir);
  try {
    expect(await restored.view("me")).toMatchObject({ spec: { pollIntervalMinutes: 4 }, host: { pollIntervalMs: 240_000 } });
  } finally { await restored.close(); }
});
