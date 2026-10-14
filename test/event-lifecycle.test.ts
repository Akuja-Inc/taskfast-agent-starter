import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";import { afterEach, expect, it, vi } from "vitest";
import type { Storage } from "@earendil-works/pi-durable";
import { setTimeout as sleep } from "node:timers/promises";
import { EVENT_RETRY, openMarketplaceAgent, type MarketplaceAgent } from "../src/core/agent.js";
import { cliEnv, runCli } from "../src/core/cli.js";
import type { Command } from "../src/core/policy.js";
import { runEventPump, runEventPumpForever } from "../src/core/pump.js";
import { parseAgentSpec } from "../src/core/spec.js";
import type { MarketEvent, Runtime } from "../src/core/types.js";
import { runAgents } from "../src/run.js";
import { failingStorage } from "./failing-storage.js";

const context = BACKGROUND_CONTEXT;
const dirs: string[] = [];
const agents: MarketplaceAgent[] = [];
const stops: AbortController[] = [];
const runs: Promise<unknown>[] = [];
const gates: { resolve(): void }[] = [];
const originalBin = process.env.TASKFAST_BIN;
afterEach(async () => {
  stops.splice(0).forEach((stop) => stop.abort());
  gates.splice(0).forEach((gate) => gate.resolve());
  await Promise.allSettled(runs.splice(0));
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  if (originalBin === undefined) delete process.env.TASKFAST_BIN;
  else process.env.TASKFAST_BIN = originalBin;
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function marker() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  const result = { promise, resolve };
  gates.push(result);
  return result;
}
function stopSignal() {
  const stop = new AbortController();
  stops.push(stop);
  return stop;
}
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "event-lifecycle-"));
  dirs.push(dir);
  return dir;
}
function selectedModels(responses: FauxResponseStep[] = []) {
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return { faux, models };
}
function spec() {
  return parseAgentSpec({
    ...JSON.parse(readFileSync(new URL("../examples/careful-worker.json", import.meta.url), "utf8")),
    model: "faux:test",
  });
}
const event = (id: string): MarketEvent => ({ event_id: id, event: "task.updated", task_id: "11111111-1111-4111-8111-111111111111" });
const identityCommand: Command = async (_runtime, args) => {
  if (JSON.stringify(args) !== JSON.stringify(["me"])) throw new Error("event lifecycle fixture permits only the identity read");
  return { outcome: "ok", data: { profile: { id: "33333333-3333-4333-8333-333333333333" } } };
};
async function open({ dir, selected, recoverEveryMs = 20, runtime = { env: "staging", configPath: join(dir, "config.json") }, command = identityCommand, now, log, openStorage }: { dir: string; selected: ReturnType<typeof selectedModels>; recoverEveryMs?: number; runtime?: Runtime; command?: Command; now?: () => Date; log?: (line: string) => void; openStorage?: (file: string) => Promise<Storage> }) {
  const agent = await openMarketplaceAgent({ storePath: join(dir, "state.sqlite"), spec: spec(), runtime, models: selected.models, recoverEveryMs, command, now, log, openStorage });
  agents.push(agent);
  return agent;
}
function streamFixture({ dir, configPath = join(dir, "config.json"), incoming, exitAfterAck = false }: { dir: string; configPath?: string; incoming?: MarketEvent; exitAfterAck?: boolean }) {
  const bin = join(dir, "taskfast");
  writeFileSync(bin, `#!${process.execPath}\n` + readFileSync(new URL("fixtures/event-stream.mjs", import.meta.url), "utf8"));
  chmodSync(bin, 0o700);
  const journal = join(dir, "stream.jsonl");
  writeFileSync(configPath, JSON.stringify({ journal, event: incoming, exitAfterAck }));
  const runtime: Runtime = { env: "staging", configPath };
  return { bin, runtime, journal };
}
function records(path: string): { kind: string; pid: number; cwd: string; id?: string; configPath?: string }[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || !("kind" in value) || typeof value.kind !== "string" || !("pid" in value) || typeof value.pid !== "number" || !("cwd" in value) || typeof value.cwd !== "string") throw new Error("invalid stream journal record");
    const id = "id" in value ? value.id : undefined;
    const configPath = "configPath" in value ? value.configPath : undefined;
    if ((id !== undefined && typeof id !== "string") || (configPath !== undefined && typeof configPath !== "string")) throw new Error("invalid stream journal fields");
    return { kind: value.kind, pid: value.pid, cwd: value.cwd, ...(id === undefined ? {} : { id }), ...(configPath === undefined ? {} : { configPath }) };
  });
}
async function waitForRecord({ path, kind, count = 1 }: { path: string; kind: string; count?: number }) {
  await expect.poll(() => records(path).filter((item) => item.kind === kind).length, { timeout: 4000 }).toBeGreaterThanOrEqual(count);
}
async function eventInputs(agent: MarketplaceAgent) {
  const transcript = await agent.conversation.context(context);
  return transcript.messages.filter((message) => message.role === "user").flatMap((message) => {
    const content = typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    return content.startsWith("Marketplace event:\n") ? [content] : [];
  });
}
function expectChildrenStopped(journal: string) {
  const children = new Set(records(journal).filter((item) => item.kind === "start").map((item) => item.pid));
  expect(children.size).toBeGreaterThan(0);
  for (const pid of children) expect(() => process.kill(pid, 0)).toThrow();
}

it("the real pump ACKs durable admission, not a blocked model, and the admitted input survives reopening", async () => {
  const dir = directory();
  const modelStarted = marker();
  const modelRelease = marker();
  const selected = selectedModels([async () => { modelStarted.resolve(); await modelRelease.promise; return fauxAssistantMessage("Poll complete"); }, fauxAssistantMessage("Event complete")]);
  const agent = await open({ dir, selected });
  await agent.ping();
  await modelStarted.promise;
  const fixture = streamFixture({ dir, incoming: event("ack-after-admission") });
  const stop = stopSignal();
  const deliveryStarted = marker();
  const admissionRelease = marker();
  const pump = runEventPump({
    taskfastBin: fixture.bin, env: "staging", cliEnv: cliEnv(fixture.runtime), signal: stop.signal,
    deliver: async (incoming) => { deliveryStarted.resolve(); await admissionRelease.promise; await agent.deliver(incoming); },
    deliverTimeoutMs: 4000,
  });
  runs.push(pump);
  await deliveryStarted.promise;
  expect(records(fixture.journal).filter((item) => item.kind === "ack")).toEqual([]);
  admissionRelease.resolve();
  await waitForRecord({ path: fixture.journal, kind: "ack" });
  expect(selected.faux.state.callCount).toBe(1); // The provider is still blocked.
  expect(records(fixture.journal).filter((item) => item.kind === "ack").map((item) => item.id)).toEqual(["ack-after-admission"]);
  stop.abort();
  await pump;
  modelRelease.resolve();
  await agent.recover();
  await agent.waitForIdle();
  await agent.close();
  const fresh = selectedModels([fauxAssistantMessage("Unexpected duplicate")]);
  const reopened = await open({ dir, selected: fresh });
  await reopened.deliver(event("ack-after-admission"));
  await reopened.recover();
  await reopened.waitForIdle();
  expect(await eventInputs(reopened)).toHaveLength(1);
  expect(fresh.faux.state.callCount).toBe(0);
});

it("does not ACK when durable admission fails because the agent's store is closed", async () => {
  const dir = directory();
  const agent = await open({ dir, selected: selectedModels() });
  await agent.close();
  const fixture = streamFixture({ dir, incoming: event("not-admitted") });
  const stop = stopSignal();
  const logs: string[] = [];
  const pumping = runEventPump({
    taskfastBin: fixture.bin, env: "staging", cliEnv: cliEnv(fixture.runtime), signal: stop.signal,
    deliver: (incoming) => agent.deliver(incoming), log: (line) => logs.push(line), deliverTimeoutMs: 1000,
  });
  runs.push(pumping);
  await expect.poll(() => logs.some((line) => line.includes("deliver not-admitted failed (1), not acked")), { timeout: 4000 }).toBe(true);
  expect(records(fixture.journal).filter((item) => item.kind === "ack")).toEqual([]);
  stop.abort();
  await pumping;
  expectChildrenStopped(fixture.journal);
});

it("restarts exited stream children and ACKs a replay without duplicating model input", async () => {
  const dir = directory();
  const selected = selectedModels([fauxAssistantMessage("Event complete")]);
  const agent = await open({ dir, selected });
  const fixture = streamFixture({ dir, incoming: event("replayed-event"), exitAfterAck: true });
  const stop = stopSignal();
  const logs: string[] = [];
  const pumping = runEventPumpForever({
    taskfastBin: fixture.bin, env: "staging", cliEnv: cliEnv(fixture.runtime), signal: stop.signal,
    deliver: (incoming) => agent.deliver(incoming), log: (line) => logs.push(line), minDelayMs: 10, maxDelayMs: 20,
  });
  runs.push(pumping);
  await waitForRecord({ path: fixture.journal, kind: "ack", count: 2 });
  stop.abort();
  await pumping;
  await agent.recover();
  await agent.waitForIdle();
  expect(logs.some((line) => line.includes("stream exited with 0"))).toBe(true);
  expect(new Set(records(fixture.journal).filter((item) => item.kind === "ack").map((item) => item.pid)).size).toBeGreaterThanOrEqual(2);
  expect(await eventInputs(agent)).toHaveLength(1);
  expect(selected.faux.state.callCount).toBe(1);
  expectChildrenStopped(fixture.journal);
});

it("automatically drains queued follow-up events after a model failure, without a host ping or manual recovery", async () => {
  const dir = directory();
  const started = marker();
  const release = marker();
  const successfulInputs: string[] = [];
  const complete: FauxResponseStep = (input) => {
    successfulInputs.push(JSON.stringify(input.messages));
    return fauxAssistantMessage("Queued events complete");
  };
  const selected = selectedModels([
    async () => { started.resolve(); await release.promise; return fauxAssistantMessage("", { stopReason: "error", errorMessage: "scripted model failure" }); },
    ...Array.from({ length: 8 }, () => complete),
  ]);
  const agent = await open({ dir, selected });
  await agent.ping();
  await started.promise;
  await agent.deliver(event("queued-one"));
  await agent.deliver(event("queued-two"));
  await agent.recover(); // Persist both submissions while the first run is blocked.
  release.resolve();
  await expect.poll(() => successfulInputs.some((input) => input.includes("queued-two")), { timeout: 4000 }).toBe(true);
  await agent.waitForIdle();
  const inputs = await eventInputs(agent);
  expect(successfulInputs.some((input) => input.includes("queued-one"))).toBe(true);
  // A failed placed submission may be retried; both queued events must reach
  // a successful model invocation rather than remain stranded after resume().
  expect(inputs.length).toBeGreaterThanOrEqual(2);
  expect(inputs.some((input) => input.includes('"event_id":"queued-one"'))).toBe(true);
  expect(inputs.some((input) => input.includes('"event_id":"queued-two"'))).toBe(true);
});

it("reopening recovers an admitted event whose model run failed before shutdown", async () => {
  const dir = directory();
  const failed = selectedModels([fauxAssistantMessage("", { stopReason: "error", errorMessage: "scripted model failure" })]);
  const agent = await open({ dir, selected: failed, recoverEveryMs: 60_000 });
  await agent.deliver(event("recover-after-restart"));
  await agent.recover();
  await agent.waitForIdle();
  expect(failed.faux.state.callCount).toBe(1);
  await agent.close();
  const denied = selectedModels([fauxAssistantMessage("Must not resume without identity")]);
  const identityReads: string[][] = [];
  await expect(open({ dir, selected: denied, command: async (_runtime, args) => {
    identityReads.push(args);
    return { outcome: "failed", error: "auth: refused" };
  } })).rejects.toThrow(/identity/);
  expect(identityReads).toEqual([["me"]]);
  expect(denied.faux.state.callCount).toBe(0);
  const retried = marker();
  const recovered = selectedModels([(input) => {
    expect(JSON.stringify(input.messages)).toContain("recover-after-restart");
    retried.resolve();
    return fauxAssistantMessage("Recovered event complete");
  }]);
  let skew = 0;
  const reopened = await open({ dir, selected: recovered, now: () => new Date(Date.now() + skew) });
  await reopened.waitForIdle();
  expect(recovered.faux.state.callCount).toBe(0); // Opening observed the failure and scheduled its retry.
  skew = 2 * EVENT_RETRY.minTimeout;
  await expect.poll(() => recovered.faux.state.callCount, { timeout: 4000 }).toBe(1);
  await retried.promise;
  await reopened.waitForIdle();
  await reopened.recover();
  await reopened.deliver(event("recover-after-restart"));
  await reopened.recover();
  await reopened.waitForIdle();
  expect(recovered.faux.state.callCount).toBe(1);
});

const modelFailure = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "scripted model failure" });
// The retry delay after the nth failed run of an event, scaled by its jitter factor (1 to 2).
const retryDelay = (n: number, jitter: number) => Math.min(jitter * EVENT_RETRY.minTimeout * EVENT_RETRY.factor ** n, EVENT_RETRY.maxTimeout);

it("resubmits a failing event run after growing, jittered delays and then abandons it for good", async () => {
  const dir = directory();
  let at = Date.parse("2026-06-20T12:00:00Z");
  const now = () => new Date(at);
  const logs: string[] = [];
  const selected = selectedModels(Array.from({ length: EVENT_RETRY.retries + 1 }, () => modelFailure));
  const agent = await open({ dir, selected, recoverEveryMs: 60_000, now, log: (line) => logs.push(line) });
  await agent.deliver(event("keeps-failing"));
  await agent.recover();
  await agent.waitForIdle();
  for (let n = 0; n < EVENT_RETRY.retries; n++) {
    const failedAt = at;
    await agent.recover(); // Observes the failed run and schedules the next one.
    // Jitter scales the delay above its base, so the unjittered time is not yet due
    // (it would be only if Math.random() rounds to within 1ms of zero).
    at = failedAt + retryDelay(n, 1);
    await agent.recover();
    await agent.waitForIdle();
    expect(selected.faux.state.callCount).toBe(n + 1);
    at = failedAt + retryDelay(n, 2);
    await agent.recover();
    await agent.waitForIdle();
    expect(selected.faux.state.callCount).toBe(n + 2);
  }
  await agent.recover();
  at += 24 * 3_600_000;
  await agent.recover();
  expect(selected.faux.state.callCount).toBe(EVENT_RETRY.retries + 1);
  expect(logs.filter((line) => line.includes("event:keeps-failing abandoned"))).toHaveLength(1);
  await agent.close();
  const fresh = selectedModels([fauxAssistantMessage("Must not run an abandoned event")]);
  const reopened = await open({ dir, selected: fresh, recoverEveryMs: 60_000, now });
  await reopened.deliver(event("keeps-failing"));
  await reopened.recover();
  await reopened.waitForIdle();
  expect(fresh.faux.state.callCount).toBe(0);
});

it("keeps an event's retry delay across a restart", async () => {
  const dir = directory();
  let at = Date.parse("2026-06-20T12:00:00Z");
  const now = () => new Date(at);
  const failed = selectedModels([modelFailure]);
  const agent = await open({ dir, selected: failed, recoverEveryMs: 60_000, now });
  await agent.deliver(event("mid-backoff"));
  await agent.recover();
  await agent.waitForIdle();
  await agent.recover(); // Stores the retry time of the failed run.
  await agent.close();
  const recovered = selectedModels([fauxAssistantMessage("Recovered event complete")]);
  const reopened = await open({ dir, selected: recovered, now });
  at += retryDelay(0, 1) - 1;
  await sleep(200); // Several recovery timer ticks while the retry is not due.
  await reopened.recover();
  expect(recovered.faux.state.callCount).toBe(0);
  at += retryDelay(0, 1) + 1;
  await expect.poll(() => recovered.faux.state.callCount, { timeout: 4000 }).toBe(1);
});

it("queues one resume input however many recovery passes see the same stall", async () => {
  const dir = directory();
  const started = marker();
  const release = marker();
  const selected = selectedModels([
    async () => { started.resolve(); await release.promise; return modelFailure(); },
    ...Array.from({ length: 20 }, () => modelFailure),
  ]);
  const at = Date.parse("2026-06-20T12:00:00Z");
  const agent = await open({ dir, selected, now: () => new Date(at) }); // Frozen time: no event retry comes due.
  const submit = vi.spyOn(agent.conversation, "submit");
  await agent.ping();
  await started.promise;
  for (const id of ["stalled-one", "stalled-two", "stalled-three"]) await agent.deliver(event(id));
  await agent.recover(); // Persist the queued submissions while the first run is blocked.
  release.resolve();
  for (let tick = 0; tick < 5; tick++) {
    await sleep(100); // Several recovery timer ticks while every run fails.
    await agent.waitForIdle();
  }
  expect(submit.mock.calls.filter(([draft]) => draft.requestId?.startsWith("resume:"))).toHaveLength(1);
});

function hostAgent({ root, id }: { root: string; id: string }) {
  const home = join(root, "agents", id);
  mkdirSync(join(home, ".taskfast"), { recursive: true });
  writeFileSync(join(home, "agent.json"), JSON.stringify(spec()));
  const fixture = streamFixture({ dir: root, configPath: join(home, ".taskfast", "config.json") });
  return { home, fixture, storeDir: join(home, ".pi-state", "staging") };
}

it("a failed session stops that agent: the host logs it and closes its stream before its store", async () => {
  const root = directory();
  const { storeDir } = hostAgent({ root, id: "worker" });
  const order: string[] = [];
  const logs: string[] = [];
  let armed = false;
  const stop = stopSignal();
  const host = runAgents({
    agentsDir: join(root, "agents"), env: "staging", signal: stop.signal, pingEveryMs: 30,
    log: (line) => logs.push(line),
    listen: () => ({ close: async () => { order.push("listener"); } }),
    openAgent: async ({ runtime, storePath }) => {
      const agent = await open({ dir: dirname(storePath), selected: selectedModels([fauxAssistantMessage("Poll complete")]), runtime, openStorage: (file) => failingStorage(file, () => armed) });
      armed = true; // The first host ping's write hits storage and fails the session.
      return { ...agent, close: async () => { order.push("agent"); await agent.close(); } };
    },
  });
  runs.push(host);
  try {
    await expect.poll(() => order.join(","), { timeout: 4000 }).toBe("listener,agent");
    expect(logs.some((line) => line.includes("worker: session failed: injected storage failure; stopping the agent"))).toBe(true);
  } finally {
    stop.abort();
    await host;
  }
  expect(order).toEqual(["listener", "agent"]);
});

it("the host's periodic poll survives restart and abort closes real agents and listeners", async () => {
  const root = directory();
  const { fixture, storeDir } = hostAgent({ root, id: "worker" });
  process.env.TASKFAST_BIN = fixture.bin;
  for (let restart = 0; restart < 2; restart++) {
    const selected = selectedModels(Array.from({ length: 20 }, () => fauxAssistantMessage("Poll complete")));
    const stop = stopSignal();
    const host = runAgents({
      agentsDir: join(root, "agents"), env: "staging", signal: stop.signal, log: () => {}, pingEveryMs: 30,
      openAgent: async ({ runtime, storePath }) => open({ dir: dirname(storePath), selected, runtime, command: runCli }),
    });
    runs.push(host);
    await waitForRecord({ path: fixture.journal, kind: "start", count: restart + 1 });
    expect(records(fixture.journal).filter((item) => item.kind === "me")).toHaveLength(restart + 1);
    expect(records(fixture.journal).filter((item) => item.kind === "version" || item.kind === "start").map((item) => item.cwd)).toEqual(Array((restart + 1) * 2).fill(dirname(dirname(fixture.runtime.configPath))));
    await expect.poll(() => selected.faux.state.callCount, { timeout: 4000 }).toBeGreaterThanOrEqual(2);
    stop.abort();
    await host;
    expectChildrenStopped(fixture.journal);
  }
  // Opening the same store also proves the host released its ownership lock.
  const reopened = await open({ dir: storeDir, selected: selectedModels(), runtime: fixture.runtime });
  await reopened.close();
});

it("the host passes its unlock path into agent runtime options", async () => {
  const root = directory();
  const { fixture, storeDir } = hostAgent({ root, id: "worker" });
  process.env.TASKFAST_BIN = fixture.bin;
  const selected = selectedModels(Array.from({ length: 20 }, () => fauxAssistantMessage("Poll complete")));
  const stop = stopSignal();
  const files: (string | undefined)[] = [];
  const file = join(root, "user-owned-wallet.pw");
  const host = runAgents({
    agentsDir: join(root, "agents"), env: "staging", walletPasswordFile: file, signal: stop.signal, log: () => {}, pingEveryMs: 30,
    openAgent: async ({ runtime, storePath }) => { files.push(runtime.walletPasswordFile); return open({ dir: dirname(storePath), selected, runtime, command: runCli }); },
  });
  runs.push(host);
  try { await waitForRecord({ path: fixture.journal, kind: "start" }); expect(files).toEqual([file]); }
  finally { stop.abort(); await host; }
});

it("a partial host startup failure closes previously opened stores and event children", async () => {
  const root = directory();
  const first = hostAgent({ root, id: "a-worker" });
  const second = hostAgent({ root, id: "b-worker" });
  process.env.TASKFAST_BIN = first.fixture.bin;
  const held = await open({ dir: second.storeDir, selected: selectedModels() });
  const stop = stopSignal();
  const selected = selectedModels();
  const host = runAgents({
    agentsDir: join(root, "agents"), env: "staging", signal: stop.signal, log: () => {},
    openAgent: async ({ id, runtime, storePath }) => {
      if (id === "b-worker") await waitForRecord({ path: first.fixture.journal, kind: "start" });
      return open({ dir: dirname(storePath), selected, runtime, command: runCli });
    },
  });
  runs.push(host);
  await expect(host).rejects.toThrow("agent store is already owned");
  expectChildrenStopped(first.fixture.journal);
  expect(records(first.fixture.journal).filter((item) => item.kind === "start").map((item) => item.configPath)).toEqual([first.fixture.runtime.configPath]);
  const reopened = await open({ dir: first.storeDir, selected: selectedModels(), runtime: first.fixture.runtime });
  await reopened.close();
  await held.close();
});
