import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it, vi } from "vitest";
import { example } from "../../test/example.js";
import { openMarketplaceAgent, type MarketplaceAgent } from "./agent.js";
import { EVENT_RETRY } from "./events.js";
import * as scheduling from "./gate.js";
import * as mcp from "./mcp.js";
import { Operator } from "./operator.js";
import { parseAgentSpec } from "./spec.js";

const context = BACKGROUND_CONTEXT;
const dirs: string[] = [];
const agents: MarketplaceAgent[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function marker() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  releases.push(resolve);
  return { promise, resolve };
}
async function open() {
  const dir = mkdtempSync(join(tmpdir(), "agent-recovery-"));
  dirs.push(dir);
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const factory = scheduling.openSchedulingGate;
  let hostPass!: () => Promise<void>;
  let pass!: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let gate!: ReturnType<typeof factory>;
  vi.spyOn(scheduling, "openSchedulingGate").mockImplementation((host) => {
    hostPass = host.pass;
    pass = vi.fn(host.pass);
    gate = factory({ ...host, pass });
    vi.spyOn(gate, "run");
    vi.spyOn(gate, "fresh");
    return gate;
  });
  const clock = { at: Date.parse("2026-11-16T00:00:00Z") };
  const logs: string[] = [];
  const agent = await openMarketplaceAgent({
    storePath: join(dir, "state.sqlite"),
    spec: { ...parseAgentSpec(example("careful-worker")), model: "faux:test" },
    runtime: { env: "staging", configPath: join(dir, "config.json") }, models,
    now: () => new Date(clock.at), recoverEveryMs: 60_000, log: (line) => logs.push(line),
    command: async () => ({ outcome: "ok", data: { profile: { id: "33333333-3333-4333-8333-333333333333" } } }),
  });
  agents.push(agent);
  const requests = () => vi.mocked(gate.run).mock.calls.length + vi.mocked(gate.fresh).mock.calls.length;
  const blockNextPass = () => {
    const entered = marker();
    const release = marker();
    pass.mockImplementationOnce(async () => {
      await hostPass();
      entered.resolve();
      await release.promise;
    });
    return { entered: entered.promise, release: release.resolve };
  };
  return { agent, faux, clock, logs, pass, requests, blockNextPass };
}

it("steer starts a fresh drain when it joins a pass whose drain already finished", async () => {
  const kit = await open();
  const blocked = kit.blockNextPass();
  const stale = kit.agent.recover();
  await blocked.entered;
  // Seed a buffered admission after the old drain to isolate the promotion's wakeup.
  await kit.agent.conversation.commit(async (tx) => {
    const state = await tx.doc(Operator);
    state.messages.push({ requestId: "promote", text: "Handle this correction.", mode: "followUp" });
  }, context);
  kit.faux.setResponses([fauxAssistantMessage("Correction handled.")]);
  const before = kit.requests();
  const promoting = kit.agent.operator.steer("promote");
  await expect.poll(kit.requests).toBeGreaterThan(before);
  blocked.release();
  expect(await promoting).toBe("steered");
  await stale;
  await kit.agent.waitForIdle();
  expect(kit.faux.state.callCount).toBe(1);
  expect((await kit.agent.operator.state()).messages).toEqual([]);
  expect(JSON.stringify(await kit.agent.transcript(100))).toContain("Correction handled.");
});

it("event retry starts a fresh pass after joining one that already saw abandonment", async () => {
  const kit = await open();
  const failure = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "scripted failure" });
  kit.faux.setResponses(Array.from({ length: EVENT_RETRY.retries + 1 }, failure));
  await kit.agent.deliver({ event_id: "stuck", event: "message_received" });
  for (let n = 0; n <= 2 * EVENT_RETRY.retries; n++) {
    await kit.agent.recover();
    await kit.agent.waitForIdle();
    kit.clock.at += 3_600_000;
  }
  await kit.agent.recover();
  expect((await kit.agent.operator.events())["event:stuck"].kind).toBe("abandoned");
  const blocked = kit.blockNextPass();
  const stale = kit.agent.recover();
  await blocked.entered;
  kit.faux.setResponses([fauxAssistantMessage("Retry handled.")]);
  const before = kit.requests();
  const retrying = kit.agent.operator.retryEvent("stuck");
  await expect.poll(kit.requests).toBeGreaterThan(before);
  blocked.release();
  await Promise.all([stale, retrying]);
  await kit.agent.waitForIdle();
  expect(kit.faux.state.callCount).toBe(EVENT_RETRY.retries + 2);
  expect((await kit.agent.operator.events())["event:stuck"]).toMatchObject({ kind: "submitted", attempt: EVENT_RETRY.retries + 1 });
  expect(JSON.stringify(await kit.agent.transcript(100))).toContain("Retry handled.");
});

it("logs one recovery failure when the timer and an owner action join the same pass", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const kit = await open();
  const entered = marker();
  const release = marker();
  kit.pass.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    throw new Error("injected recovery failure");
  });
  await vi.advanceTimersByTimeAsync(60_000);
  await entered.promise;
  kit.faux.setResponses([fauxAssistantMessage("Message handled.")]);
  const before = kit.requests();
  const admitting = kit.agent.operator.message({ requestId: "joined", text: "A new instruction." });
  await expect.poll(kit.requests).toBeGreaterThan(before);
  release.resolve();
  await admitting;
  await kit.agent.waitForIdle();
  expect(kit.logs).toEqual(["recovery: Error: injected recovery failure"]);
  expect(kit.faux.state.callCount).toBe(1);
});

it("reports a close failure once without retrying cleanup on subsequent closes", async () => {
  const connect = mcp.connectMcp;
  const close = vi.fn(async () => { throw new Error("injected cleanup failure"); });
  vi.spyOn(mcp, "connectMcp").mockImplementation(async (...args) => {
    const connection = await connect(...args);
    return { ...connection, close: async () => { await connection.close(); await close(); } };
  });
  const kit = await open();
  await expect(kit.agent.close()).rejects.toThrow("injected cleanup failure");
  await expect(kit.agent.close()).resolves.toBeUndefined();
  expect(close).toHaveBeenCalledTimes(1);
});
