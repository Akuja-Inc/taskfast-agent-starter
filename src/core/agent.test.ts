import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it } from "vitest";
import { openMarketplaceAgent, type MarketplaceAgent } from "./agent.js";
import type { CliResult } from "./cli.js";
import type { AgentSpec } from "./types.js";
import { parseAgentSpec } from "./spec.js";

const context = BACKGROUND_CONTEXT;
const dirs: string[] = [];
const opened: MarketplaceAgent[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((agent) => agent.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const task = "11111111-1111-4111-8111-111111111111";
const post = { title: "Edit the guide", description: "Copy edit the short guide.", budget: "10.00", pickup_deadline_hours: 24 };
function spec(): AgentSpec {
  const value: unknown = JSON.parse(readFileSync(new URL("../../examples/brisk-poster.json", import.meta.url), "utf8"));
  return { ...parseAgentSpec(value), model: "faux:test", limits: { dailyUsd: 5, perJobUsd: 4 } };
}
function testModels() {
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}
async function open(options: Partial<Parameters<typeof openMarketplaceAgent>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "marketplace-agent-"));
  dirs.push(dir);
  const selected = testModels();
  const calls: string[][] = [];
  const agent = await openMarketplaceAgent({
    storePath: join(dir, "state.sqlite"), spec: spec(), runtime: { env: "staging", configPath: join(dir, "config.json") }, models: selected.models,
    command: async (_rt, args): Promise<CliResult> => { calls.push(args); return args[0] === "platform" ? { outcome: "ok", data: { config: { submission_fee: "3.00" } } } : { outcome: "ok", data: { accepted: true } }; },
    ...options,
  });
  opened.push(agent);
  return { agent, calls, ...selected, dir };
}
async function run(agent: MarketplaceAgent) { await agent.ping(); await agent.waitForIdle(); }

it("runs real Pi tools, retains notes and blocks business keys after reset and reopen", async () => {
  const kit = await open();
  kit.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("remember", { note: "Keep the guide concise." }), fauxToolCall("post_task", post)], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"),
  ]);
  await run(kit.agent);
  const state = await kit.agent.status();
  expect(state.memory).toEqual(["Keep the guide concise."]);
  expect(Object.values(state.actions).map((action) => action.status)).toEqual(["done"]);
  expect(kit.calls.filter((args) => args[0] === "post")).toHaveLength(1);
  await kit.agent.conversation.reset(undefined, context);
  await kit.agent.close();
  const fresh = testModels();
  fresh.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post, { id: "new-call-id" })], { stopReason: "toolUse" }), fauxAssistantMessage("Skipped")]);
  const reopened = await openMarketplaceAgent({ storePath: join(kit.dir, "state.sqlite"), spec: spec(), runtime: { env: "staging", configPath: join(kit.dir, "config.json") }, models: fresh.models, command: async (_rt, args) => { kit.calls.push(args); return { outcome: "ok" }; } });
  opened.push(reopened);
  await run(reopened);
  expect(kit.calls.filter((args) => args[0] === "post")).toHaveLength(1);
  expect((await reopened.status()).memory).toEqual(["Keep the guide concise."]);
});

it("keeps the host unlock path available at the command boundary", async () => {
  const file = "/tmp/user-owned-wallet.pw";
  const kit = await open({ runtime: { env: "staging", configPath: "/tmp/host-config.json", walletPasswordFile: file }, command: async (runtime, args) => {
    if (args[0] === "platform") return { outcome: "ok", data: { config: { submission_fee: "3.00" } } };
    return runtime.walletPasswordFile === file ? { outcome: "ok" } : { outcome: "failed", error: "keystore: host unlock file missing" };
  } });
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post)], { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
  await run(kit.agent);
  expect(Object.values((await kit.agent.status()).actions).map((action) => action.status)).toEqual(["done"]);
});

it("does not reserve or dispatch a money tool aborted during its server read", async () => {
  let startRead = () => {};
  let releaseRead = () => {};
  const started = new Promise<void>((resolve) => { startRead = resolve; });
  const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const writes: string[][] = [];
  const kit = await open({ command: async (_rt, args) => {
    if (args[0] === "platform") {
      startRead(); await gate;
      return { outcome: "ok", data: { config: { submission_fee: "3.00" } } };
    }
    writes.push(args); return { outcome: "ok" };
  } });
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post)], { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
  await kit.agent.ping();
  await started;
  const aborting = kit.agent.conversation.abort(context);
  try {
    // Observe Pi's public task lifecycle, not the application's SQLite tables.
    await expect.poll(async () => (await kit.agent.conversation.commit((tx) => tx.scanTasks({ conversationId: kit.agent.conversation.id, kind: "pi.tool", abortRequested: true }, 1), context)).items.length).toBe(1);
  } finally { releaseRead(); }
  await aborting;
  expect(writes).toEqual([]);
  expect((await kit.agent.status()).actions).toEqual({});
  expect((await kit.agent.status()).spend).toEqual({});
});

it("keeps a dispatched write committed when its Pi tool is aborted", async () => {
  let entered = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  const kit = await open({ command: async (_rt, args) => {
    if (args[0] === "platform") return { outcome: "ok", data: { config: { submission_fee: "3.00" } } };
    writes++; entered(); await gate; return { outcome: "ok" };
  } });
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post)], { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
  await kit.agent.ping(); await started;
  const aborting = kit.agent.conversation.abort(context);
  try {
    await expect.poll(async () => (await kit.agent.conversation.commit((tx) => tx.scanTasks({ conversationId: kit.agent.conversation.id, kind: "pi.tool", abortRequested: true }, 1), context)).items.length).toBe(1);
  } finally { release(); }
  await aborting;
  expect(Object.values((await kit.agent.status()).spend)).toEqual([3]);
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post)], { stopReason: "toolUse" }), fauxAssistantMessage("Skipped")]);
  await run(kit.agent);
  expect(writes).toBe(1);
});

it("serializes a multi-tool money round against its shared daily limit", async () => {
  const kit = await open();
  kit.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("post_task", post), fauxToolCall("post_task", { ...post, title: "Edit another guide" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"),
  ]);
  await run(kit.agent);
  expect(kit.calls.filter((args) => args[0] === "post")).toHaveLength(1);
  expect(Object.values((await kit.agent.status()).spend)).toEqual([3]);
  const messages = await kit.agent.conversation.context(context);
  expect(JSON.stringify(messages.messages)).toContain("more than your $5 a day");
});

it("refunds a proven refusal and permits a fresh attempt, but charges uncertainty", async () => {
  let outcome: CliResult = { outcome: "failed", error: "validation: refused" };
  const writes: string[][] = [];
  const kit = await open({ command: async (_rt, args) => {
    if (args[0] === "platform") return { outcome: "ok", data: { config: { submission_fee: "3.00" } } };
    writes.push(args); return outcome;
  } });
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post)], { stopReason: "toolUse" }), fauxAssistantMessage("Refused")]);
  await run(kit.agent);
  expect(Object.values((await kit.agent.status()).spend)).toEqual([0]);
  outcome = { outcome: "uncertain", error: "connection lost" };
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post)], { stopReason: "toolUse" }), fauxAssistantMessage("Uncertain")]);
  await run(kit.agent);
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post)], { stopReason: "toolUse" }), fauxAssistantMessage("Skipped")]);
  await run(kit.agent);
  expect(writes).toHaveLength(2);
  expect(Object.values((await kit.agent.status()).actions).map((action) => action.status)).toEqual(["uncertain"]);
  expect(Object.values((await kit.agent.status()).spend)).toEqual([3]);
});

it("starts a new UTC spending day without clearing completed keys", async () => {
  let now = new Date("2026-06-20T23:59:00Z");
  const kit = await open({ now: () => now });
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post)], { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
  await run(kit.agent);
  now = new Date("2026-06-21T00:01:00Z");
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", { ...post, title: "Edit another guide" })], { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
  await run(kit.agent);
  expect((await kit.agent.status()).spend).toEqual({ "2026-06-20": 3, "2026-06-21": 3 });
  expect(Object.keys((await kit.agent.status()).actions)).toHaveLength(2);
});

it("checks counterparties before reserving or dispatching a write", async () => {
  const calls: string[][] = [];
  const kit = await open({ runtime: { env: "staging", configPath: "/tmp/agent-config.json", counterparties: { me: task, accounts: ["22222222-2222-4222-8222-222222222222"], agents: [] } }, command: async (_rt, args) => {
    calls.push(args); return { outcome: "ok", data: { task: { poster_id: "other" } } };
  } });
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("bid_create", { task_id: task, price: "10.00" })], { stopReason: "toolUse" }), fauxAssistantMessage("Refused")]);
  await run(kit.agent);
  expect(calls.map((args) => args.slice(0, 2))).toEqual([["task", "get"]]);
  expect((await kit.agent.status()).actions).toEqual({});
});

it("admits and deduplicates events while a model run is blocked", async () => {
  const kit = await open();
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  kit.faux.setResponses([async () => { started?.(); await gate; return fauxAssistantMessage("Done"); }, fauxAssistantMessage("Handled event")]);
  await kit.agent.ping();
  await ready;
  try {
    const event = { event_id: "evt-1", event: "task.updated", task_id: task };
    await kit.agent.deliver(event);
    await kit.agent.deliver(event);
    // Delivery resolved before the model was released, so the pump can ACK.
    expect(kit.faux.state.callCount).toBe(1);
  } finally { release?.(); }
  await kit.agent.recover();
  await kit.agent.waitForIdle();
  expect(kit.faux.state.callCount).toBe(2);
});

it("preserves marketplace policy when Pi actually compacts the transcript", async () => {
  const kit = await open();
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post)], { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
  await run(kit.agent);
  const before = await kit.agent.status();
  for (let index = 0; index < 8; index++) {
    await kit.agent.conversation.submit({ type: "write", entry: { kind: "app.context", model: [{ role: "user", content: "Marketplace background. ".repeat(5000), timestamp: index }] } }, context);
  }
  kit.faux.setResponses([fauxAssistantMessage("Earlier marketplace work was completed; check the permanent action ledger.")]);
  await kit.agent.conversation.compact(undefined, context);
  await kit.agent.waitForIdle();
  expect((await kit.agent.conversation.context(context)).head?.kind).toBe("pi.compaction");
  expect(await kit.agent.status()).toEqual(before);
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post)], { stopReason: "toolUse" }), fauxAssistantMessage("Skipped")]);
  await run(kit.agent);
  expect(kit.calls.filter((args) => args[0] === "post")).toHaveLength(1);
});

it("does not allow forks to create separate marketplace policy owners", async () => {
  const kit = await open();
  kit.faux.setResponses([fauxAssistantMessage("Done")]);
  await run(kit.agent);
  const entries = await kit.agent.conversation.entries({}, 1, undefined, context);
  await expect(kit.agent.conversation.fork(entries.items[0].id, { ownership: { kind: "ownerless" } }, context)).rejects.toThrow(/forks are disabled/);
});
