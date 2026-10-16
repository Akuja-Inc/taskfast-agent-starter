import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it, vi } from "vitest";
import { openMarketplaceAgent, type MarketplaceAgent } from "./agent.js";
import type { CliResult } from "./cli.js";
import { example } from "../../test/example.js";
import { parseAgentSpec } from "./spec.js";

const dirs: string[] = [];
const agents: MarketplaceAgent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function kit(command?: (args: string[]) => Promise<CliResult>, startHeld = false) {
  const dir = mkdtempSync(join(tmpdir(), "capability-idle-"));
  dirs.push(dir);
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = await openMarketplaceAgent({
    storePath: join(dir, "state.sqlite"),
    spec: { ...parseAgentSpec(example("brisk-poster")), model: "faux:test" },
    runtime: { env: "staging", configPath: join(dir, "config.json") }, models, startHeld,
    command: async (_runtime, args) => args[0] === "me" ? { outcome: "ok", data: { profile: { id: "33333333-3333-4333-8333-333333333333" } } } : command ? command(args) : { outcome: "ok" },
  });
  agents.push(agent);
  return { agent, faux, dir };
}
const event = { event_id: "11111111-1111-4111-8111-111111111111", event: "task_created", task_id: "22222222-2222-4222-8222-222222222222" };

it("holds new scheduling while a write finishes, keeps durable admission and the owner's latest pause", async () => {
  const writing = gate();
  const dispatched = vi.fn();
  const { agent, faux } = await kit(async () => { dispatched(); await writing.promise; return { outcome: "ok" }; });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("task_claim", { task_id: event.task_id })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Claim finished."), fauxAssistantMessage("Received new work."),
  ]);
  let releaseHold: (() => Promise<void>) | undefined;
  try {
    await agent.ping();
    await vi.waitFor(() => expect(dispatched).toHaveBeenCalledTimes(1));
    let idle = false;
    const held = agent.quiesce(new AbortController().signal).then((release) => { idle = true; releaseHold = release; });
    await agent.deliver(event);
    await agent.operator.message({ requestId: "while-waiting", text: "Check my next job." });
    await agent.operator.setPaused(true);
    await agent.ping();
    expect(idle).toBe(false);
    expect((await agent.operator.events())[`event:${event.event_id}`]?.kind).toBe("admitted");
    writing.release();
    await held;
    expect(Object.values((await agent.status()).actions).map(({ status }) => status)).toEqual(["done"]);
    expect(faux.state.callCount).toBe(2);
    expect((await agent.operator.queued()).map(({ requestId }) => requestId)).toEqual(["while-waiting"]);
    await releaseHold?.();
    expect((await agent.operator.state()).paused).toBe(true);
    expect((await agent.operator.events())[`event:${event.event_id}`]?.kind).toBe("admitted");
    await agent.operator.setPaused(false);
    await agent.waitForIdle();
    expect(faux.state.callCount).toBeGreaterThan(2);
    expect(dispatched).toHaveBeenCalledTimes(1);
  } finally { writing.release(); await releaseHold?.(); }
});

it("cancels a wait without aborting the current model run or leaving scheduling held", async () => {
  const model = gate();
  const { agent, faux } = await kit();
  faux.setResponses([async () => { await model.promise; return fauxAssistantMessage("Current run finished."); }, fauxAssistantMessage("Next run finished.")]);
  const cancel = new AbortController();
  try {
    await agent.ping();
    await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
    const held = agent.quiesce(cancel.signal);
    await agent.deliver(event);
    cancel.abort();
    await expect(held).rejects.toThrow();
    model.release();
    await agent.waitForIdle();
    await agent.recover();
    await agent.waitForIdle();
    expect(faux.state.callCount).toBeGreaterThanOrEqual(2);
    expect((await agent.operator.state()).paused).toBe(false);
  } finally { model.release(); }
});

it("opens a recovered event dormant until its new registry is committed and explicitly released", async () => {
  const old = await kit(undefined, true);
  await old.agent.deliver(event);
  await old.agent.close();
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("task_claim", { task_id: event.task_id })], { stopReason: "toolUse" }), fauxAssistantMessage("Completed after commit.")]);
  const writes = vi.fn();
  const replacement = await openMarketplaceAgent({
    storePath: join(old.dir, "state.sqlite"), spec: { ...parseAgentSpec(example("brisk-poster")), model: "faux:test" },
    runtime: { env: "staging", configPath: join(old.dir, "config.json") }, models, startHeld: true,
    command: async (_runtime, args) => {
      if (args[0] === "me") return { outcome: "ok", data: { profile: { id: "33333333-3333-4333-8333-333333333333" } } };
      writes(); return { outcome: "ok" };
    },
  });
  agents.push(replacement);
  await replacement.ping();
  await replacement.recover();
  expect(faux.state.callCount).toBe(0);
  expect(writes).not.toHaveBeenCalled();
  expect((await replacement.operator.events())[`event:${event.event_id}`]?.kind).toBe("admitted");
  await replacement.releaseInitialHold();
  await replacement.waitForIdle();
  await replacement.releaseInitialHold();
  expect(writes).toHaveBeenCalledTimes(1);
  expect(Object.values((await replacement.status()).actions).map(({ status }) => status)).toEqual(["done"]);
});
