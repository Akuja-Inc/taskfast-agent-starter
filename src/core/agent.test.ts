import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve, expectGone, FIXTURE, writeMcp } from "../../test/mcp-fixture.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createSession, defineDoc, LiveDoc } from "@earendil-works/pi-durable";
import { afterEach, expect, it, vi } from "vitest";
import { failingStorage } from "../../test/failing-storage.js";
import { openMarketplaceAgent, type MarketplaceAgent } from "./agent.js";
import type { CliResult } from "./cli.js";
import type { OperatorState } from "./operator.js";
import type { AgentSpec } from "./types.js";
import { parseAgentSpec } from "./spec.js";
import { openAgentStorage } from "./storage.js";
import { CleanupError } from "./cleanup-error.js";
import { example } from "../../test/example.js";

const context = BACKGROUND_CONTEXT;
const dirs: string[] = [];
const opened: MarketplaceAgent[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((agent) => agent.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const task = "11111111-1111-4111-8111-111111111111";
const agentId = "33333333-3333-4333-8333-333333333333";
const me: CliResult = { outcome: "ok", data: { profile: { id: agentId } } };
const post = { title: "Edit the guide", description: "Copy edit the short guide.", budget: "10.00", pickup_deadline_hours: 24 };
function spec(): AgentSpec {
  const value: unknown = example("brisk-poster");
  return { ...parseAgentSpec(value), model: "faux:test", limits: { dailyUsd: 5, perJobUsd: 4 } };
}
function testModels(contextWindow = 128000) {
  const faux = fauxProvider({ models: [{ id: "test", contextWindow }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}
async function open({ contextWindow, dir, ...options }: Partial<Parameters<typeof openMarketplaceAgent>[0]> & { contextWindow?: number; dir?: string } = {}) {
  if (!dir) { dir = mkdtempSync(join(tmpdir(), "marketplace-agent-")); dirs.push(dir); }
  const selected = testModels(contextWindow);
  const calls: string[][] = [];
  const agent = await openMarketplaceAgent({
    storePath: join(dir, "state.sqlite"), spec: spec(), runtime: { env: "staging", configPath: join(dir, "config.json") }, models: selected.models,
    command: async (_rt, args): Promise<CliResult> => { calls.push(args); return args[0] === "me" ? me : args[0] === "platform" ? { outcome: "ok", data: { config: { submission_fee: "3.00" } } } : { outcome: "ok", data: { accepted: true } }; },
    ...options,
  });
  opened.push(agent);
  return { agent, calls, ...selected, dir };
}
async function run(agent: MarketplaceAgent) { await agent.ping(); await agent.waitForIdle(); }
async function addContext(agent: MarketplaceAgent, content: string, timestamp = 0) {
  await agent.conversation.submit({ type: "write", entry: { kind: "app.context", model: [{ role: "user", content, timestamp }] } }, context);
}
const isSummary = (input: Parameters<FauxResponseFactory>[0]) => JSON.stringify(input.messages.filter((message) => message.role === "system")).includes("context summarization assistant");
function hold() {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { held, release };
}

it("distinguishes failed opening cleanup while the real store remains owned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marketplace-cleanup-"));
  dirs.push(dir);
  const signal = new AbortController();
  let release: (() => Promise<void>) | undefined;
  try {
    await expect(open({ dir, signal: signal.signal, openStorage: async (path) => {
      const storage = await openAgentStorage(path);
      release = () => storage.close(context);
      signal.abort();
      return new Proxy(storage, { get(target, key) {
        if (key === "close") return async () => { throw new Error("injected cleanup failure"); };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    } })).rejects.toBeInstanceOf(CleanupError);
    await expect(openAgentStorage(join(dir, "state.sqlite"))).rejects.toThrow("already owned");
  } finally { await release?.(); }
});

it("moves a stopped agent folder without losing notes, spend or completed business keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "marketplace-move-"));
  dirs.push(root);
  const home = join(root, "original");
  mkdirSync(home);
  const configPath = join(home, "simulated-account.json");
  writeFileSync(configPath, JSON.stringify({ profile: { id: agentId } }));
  const calls: string[][] = [];
  const kit = await open({ storePath: join(home, "state.sqlite"), runtime: { env: "staging", configPath }, command: async (runtime, args) => {
    calls.push(args);
    if (args[0] === "me") return { outcome: "ok", data: JSON.parse(readFileSync(runtime.configPath, "utf8")) };
    if (args[0] === "platform") return { outcome: "ok", data: { config: { submission_fee: "3.00" } } };
    return { outcome: "ok", data: { accepted: true } };
  } });
  kit.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("remember", { note: "Keep the guide concise." }), fauxToolCall("post_task", post)], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"),
  ]);
  await run(kit.agent);
  const state = await kit.agent.status();
  expect(state.memory).toEqual(["Keep the guide concise."]);
  expect(Object.values(state.actions).map((action) => action.status)).toEqual(["done"]);
  expect(calls.filter((args) => args[0] === "post")).toHaveLength(1);
  expect(Object.values(state.spend)).toEqual([3]);
  await kit.agent.conversation.reset(undefined, context);
  await kit.agent.close();
  const moved = join(root, "relocated");
  renameSync(home, moved);
  const fresh = testModels();
  fresh.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post, { id: "new-call-id" })], { stopReason: "toolUse" }), fauxAssistantMessage("Skipped")]);
  const reopened = await openMarketplaceAgent({ storePath: join(moved, "state.sqlite"), spec: spec(), runtime: { env: "staging", configPath: join(moved, "simulated-account.json") }, models: fresh.models, command: async (runtime, args) => {
    calls.push(args);
    if (args[0] === "me") return { outcome: "ok", data: JSON.parse(readFileSync(runtime.configPath, "utf8")) };
    return { outcome: "ok" };
  } });
  opened.push(reopened);
  await run(reopened);
  expect(fresh.faux.state.callCount).toBe(2);
  expect(JSON.stringify((await reopened.conversation.context(context)).messages)).toContain("already done");
  expect(calls.filter((args) => args[0] === "post")).toHaveLength(1);
  expect(calls.filter((args) => args[0] === "me")).toEqual([["me"], ["me"]]);
  expect(await reopened.status()).toEqual(state);
  expect((await reopened.status()).identity).toEqual({ env: "staging", agentId });
});

const invalidIdentities: { name: string; result: CliResult }[] = [
  { name: "absent data", result: { outcome: "ok" } },
  { name: "null data", result: { outcome: "ok", data: null } },
  { name: "missing profile", result: { outcome: "ok", data: { agent: { id: agentId } } } },
  { name: "null profile", result: { outcome: "ok", data: { profile: null } } },
  { name: "missing UUID", result: { outcome: "ok", data: { profile: {} } } },
  { name: "non-string UUID", result: { outcome: "ok", data: { profile: { id: 123 } } } },
  { name: "invalid UUID", result: { outcome: "ok", data: { profile: { id: "not-an-agent-id" } } } },
  { name: "refused identity", result: { outcome: "failed", error: "auth: refused" } },
  { name: "uncertain identity", result: { outcome: "uncertain", error: "unreadable result" } },
];
it.each(invalidIdentities)("fails closed on $name before starting marketplace work", async ({ result }) => {
  const calls: string[][] = [];
  const selected = testModels();
  selected.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post)], { stopReason: "toolUse" })]);
  await expect(open({ models: selected.models, command: async (_runtime, args) => { calls.push(args); return result; } })).rejects.toThrow(/identity|profile UUID/);
  expect(calls).toEqual([["me"]]);
  expect(selected.faux.state.callCount).toBe(0);
});

it.each([
  { name: "another account at the same config path", env: "staging", id: task },
  { name: "the same account in another environment", env: "local", id: agentId },
] satisfies { name: string; env: "staging" | "local"; id: string }[])("refuses $name without changing the permanent policy", async ({ env, id }) => {
  const kit = await open();
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("remember", { note: "Keep the paid guide's history." }), fauxToolCall("post_task", post)], { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
  await run(kit.agent);
  const before = await kit.agent.status();
  await kit.agent.close();
  const calls: string[][] = [];
  const selected = testModels();
  selected.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", { ...post, title: "A different guide" })], { stopReason: "toolUse" })]);
  const options = { storePath: join(kit.dir, "state.sqlite"), spec: spec(), runtime: { env, configPath: join(kit.dir, "config.json") }, models: selected.models };
  await expect(openMarketplaceAgent({ ...options, command: async (_runtime, args) => { calls.push(args); return { outcome: "ok", data: { profile: { id } } }; } })).rejects.toThrow(/another TaskFast account or environment/);
  expect(calls).toEqual([["me"]]);
  expect(selected.faux.state.callCount).toBe(0);
  const reopened = await openMarketplaceAgent({ ...options, runtime: { ...options.runtime, env: "staging" }, command: async (_runtime, args) => {
    calls.push(args);
    return me;
  } });
  opened.push(reopened);
  expect(await reopened.status()).toEqual(before);
  expect(calls).toEqual([["me"], ["me"]]);
});

it("refuses version 1 policy stores without migrating or resetting their permanent state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marketplace-old-policy-"));
  dirs.push(dir);
  const storePath = join(dir, "state.sqlite");
  const runtime = { env: "staging", configPath: join(dir, "config.json") } satisfies Parameters<typeof openMarketplaceAgent>[0]["runtime"];
  const state = {
    identity: { env: runtime.env, configPath: runtime.configPath },
    actions: { "post:legacy": { status: "done", at: "2026-06-20T12:00:00.000Z", amount: 3, day: "2026-06-20" } },
    spend: { "2026-06-20": 3 }, memory: ["Never repeat the old post."],
  };
  const oldPolicy = defineDoc({ kind: "taskfast.policy", version: 1, scope: "session", initial: () => state });
  const legacy = createSession(await openAgentStorage(storePath));
  try { await legacy.commit(async (tx) => { await tx.doc(oldPolicy); }, context); }
  finally { await legacy.close(context); }
  const calls: string[][] = [];
  await expect(openMarketplaceAgent({ storePath, spec: spec(), runtime, models: testModels().models, command: async (_runtime, args) => { calls.push(args); return me; } })).rejects.toThrow(/requires migration from version 1/);
  expect(calls).toEqual([["me"]]);
  const untouched = createSession(await openAgentStorage(storePath));
  try { expect(await untouched.snapshot(oldPolicy, context)).toEqual(state); }
  finally { await untouched.close(context); }
});

it("wakes a poster for its configured role and instructions rather than worker-only discovery", async () => {
  const requested = spec();
  requested.instructions = "You are Ada, who runs Ada's Shop.\n\nWhat you want right now: Hire one copy editor for the two-line setup note.\n";
  const kit = await open({ spec: requested });
  let prompt = "";
  let wake = "";
  kit.faux.setResponses([(input) => {
    prompt = input.messages.filter((value) => value.role === "system").flatMap((value) => [typeof value.content === "string" ? value.content : value.content.map((part) => part.text).join("\n"), ...Object.values(value.sections ?? {}).filter((section) => typeof section === "string")]).join("\n");
    const message = input.messages.filter((value) => value.role === "user").at(-1);
    if (message?.role === "user") wake = typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    return fauxAssistantMessage("Done");
  }]);
  await run(kit.agent);
  expect(prompt).toContain("You hire people");
  expect(prompt).toContain(requested.instructions.trim());
  expect(wake).toContain("poster");
  expect(wake).toContain("goals in your instructions");
});

it("keeps the host unlock path available at the command boundary", async () => {
  const file = "/tmp/user-owned-wallet.pw";
  const kit = await open({ runtime: { env: "staging", configPath: "/tmp/host-config.json", walletPasswordFile: file }, command: async (runtime, args) => {
    if (args[0] === "me") return me;
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
    if (args[0] === "me") return me;
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
    if (args[0] === "me") return me;
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
    if (args[0] === "me") return me;
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

it("preserves marketplace policy and operator state when Pi actually compacts the transcript", async () => {
  const kit = await open();
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post)], { stopReason: "toolUse" }), fauxAssistantMessage("Done")]);
  await run(kit.agent);
  const before = await kit.agent.status();
  // Operator state is session-scoped like Policy; a shrunken context window that
  // forces compaction must not lose it either.
  await kit.agent.operator.setPaused(true);
  for (let index = 0; index < 8; index++) {
    await kit.agent.conversation.submit({ type: "write", entry: { kind: "app.context", model: [{ role: "user", content: "Marketplace background. ".repeat(5000), timestamp: index }] } }, context);
  }
  kit.faux.setResponses([fauxAssistantMessage("Earlier marketplace work was completed; check the permanent action ledger.")]);
  await kit.agent.conversation.compact(undefined, context);
  await kit.agent.waitForIdle();
  expect((await kit.agent.conversation.context(context)).head?.kind).toBe("pi.compaction");
  expect(await kit.agent.status()).toEqual(before);
  expect((await kit.agent.operator.state()).paused).toBe(true);
  await kit.agent.operator.setPaused(false);
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post)], { stopReason: "toolUse" }), fauxAssistantMessage("Skipped")]);
  await run(kit.agent);
  expect(kit.calls.filter((args) => args[0] === "post")).toHaveLength(1);
});

it.each([
  { contextWindow: 128000, charsPerEntry: 140000, kept: ["Newest context:"] },
  { contextWindow: 32768, charsPerEntry: 35000, kept: ["Recent context:", "Newest context:"] },
])("automatically compacts with Pi defaults and preserves state across restart ($contextWindow tokens)", async ({ contextWindow, charsPerEntry, kept }) => {
  const now = () => new Date("2026-06-20T12:00:00Z");
  const kit = await open({ contextWindow, now });
  kit.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("remember", { note: "Keep the permanent ledger." }), fauxToolCall("post_task", post)], { stopReason: "toolUse" }),
    fauxAssistantMessage("Posted once."),
  ]);
  await run(kit.agent);
  const policy = await kit.agent.status();
  expect(Object.values(policy.actions).map((action) => action.status)).toEqual(["done"]);
  expect(policy.spend).toEqual({ "2026-06-20": 3 });
  expect(policy.memory).toEqual(["Keep the permanent ledger."]);
  await kit.agent.operator.setFrozen(true);
  await kit.agent.operator.addOrder("Read current state before acting.");

  // Passive entries cross the blocking threshold without a generation starting a
  // background summary first. Pi needs separate entries to find a safe cut.
  for (const label of ["Old context", "Recent context", "Newest context"]) await addContext(kit.agent, `${label}: ` + "x".repeat(charsPerEntry));
  expect((await kit.agent.conversation.context(context)).head).toBeUndefined();
  const summary = hold();
  let summaryRequest: { summary: boolean; maxTokens?: number } | undefined;
  let continued = false;
  kit.faux.setResponses([
    async (input, options) => {
      summaryRequest = { summary: isSummary(input), maxTokens: options?.maxTokens };
      await summary.held;
      return fauxAssistantMessage("Earlier work is complete. Read the permanent ledger before acting.");
    },
    () => { continued = true; return fauxAssistantMessage("Continued after compaction."); },
  ]);
  let operator: OperatorState | undefined;
  await kit.agent.ping();
  try {
    // Pi 1.2.0: floor(0.8 * 16384), below this faux model's 16384 maxTokens.
    await expect.poll(() => summaryRequest).toEqual({ summary: true, maxTokens: 13107 });
    expect(continued).toBe(false);
    await kit.agent.conversation.commit(async (tx) => {
      expect((await tx.doc(LiveDoc, kit.agent.conversation.id)).compactions).toEqual([expect.objectContaining({ reason: "threshold", blocking: true })]);
    }, context);
    // Pause does not cancel a turn already running, nor its compaction.
    await kit.agent.operator.setPaused(true);
    operator = await kit.agent.operator.state();
    expect(operator).toMatchObject({ frozen: true, paused: true, orders: ["Read current state before acting."] });
  } finally { summary.release(); }
  await kit.agent.waitForIdle();
  expect(continued).toBe(true);
  const compacted = await kit.agent.conversation.context(context);
  expect(compacted.head?.kind).toBe("pi.compaction");
  const messages = JSON.stringify(compacted.messages);
  expect(messages).not.toContain("Old context:");
  for (const label of kept) expect(messages).toContain(label);
  expect(await kit.agent.status()).toEqual(policy);
  expect(await kit.agent.operator.state()).toEqual(operator);
  await kit.agent.close();

  const reopened = await open({ dir: kit.dir, contextWindow, now });
  expect((await reopened.agent.conversation.context(context)).head?.id).toBe(compacted.head?.id);
  expect(await reopened.agent.status()).toEqual(policy);
  expect(await reopened.agent.operator.state()).toEqual(operator);
  // Unfreeze before testing deduplication, otherwise the freeze would mask a lost ledger.
  await reopened.agent.operator.setFrozen(false);
  await reopened.agent.operator.setPaused(false);
  let normalRequests = 0;
  let summaries = 0;
  const respond: FauxResponseFactory = (input) => {
    if (isSummary(input)) {
      summaries++;
      return fauxAssistantMessage("Earlier work is complete. Read the permanent ledger.");
    }
    normalRequests++;
    return normalRequests === 1
      ? fauxAssistantMessage([fauxToolCall("post_task", post, { id: "after-restart" })], { stopReason: "toolUse" })
      : fauxAssistantMessage("Skipped the completed post.");
  };
  // Small windows can still exceed the threshold after retaining 20000 recent
  // tokens. Bound requests explicitly so a repeat-compaction loop fails this test.
  reopened.faux.setResponses(Array.from({ length: 4 }, () => respond));
  await run(reopened.agent);
  expect(normalRequests).toBe(2);
  expect(summaries).toBeLessThanOrEqual(2);
  expect([...kit.calls, ...reopened.calls].filter((args) => args[0] === "post")).toHaveLength(1);
  expect(JSON.stringify((await reopened.agent.conversation.context(context)).messages)).toContain("already done");
  expect(await reopened.agent.status()).toEqual(policy);
  expect(await reopened.agent.operator.state()).toEqual({ ...operator, frozen: false, paused: false });
});

it("inherits Pi's background threshold without blocking the normal request", async () => {
  const kit = await open(); // Faux model: 128000-token window.
  for (let index = 0; index < 3; index++) await addContext(kit.agent, "x".repeat(35000), index);
  kit.faux.setResponses([fauxAssistantMessage("Below the background threshold.")]);
  await run(kit.agent);
  expect(kit.faux.state.callCount).toBe(1);
  expect((await kit.agent.conversation.context(context)).head).toBeUndefined();
  // Including faux cache-write usage, the previous request used about 53000
  // tokens. These entries add about 36000: above 78848, below 111616.
  for (let index = 0; index < 3; index++) await addContext(kit.agent, "x".repeat(42000), index);
  const summary = hold();
  let summaryStarted = false;
  let normalRequests = 0;
  const respond: FauxResponseFactory = async (input) => {
    if (isSummary(input)) {
      summaryStarted = true;
      await summary.held;
      return fauxAssistantMessage("Earlier context summarized in the background.");
    }
    normalRequests++;
    return fauxAssistantMessage("Continued while the summary was pending.");
  };
  kit.faux.setResponses([respond, respond]);
  await kit.agent.ping();
  try {
    await expect.poll(() => summaryStarted).toBe(true);
    await expect.poll(() => normalRequests).toBe(1);
    await kit.agent.waitForIdle();
    await kit.agent.conversation.commit(async (tx) => {
      expect((await tx.doc(LiveDoc, kit.agent.conversation.id)).compactions).toEqual([expect.objectContaining({ reason: "threshold", blocking: false })]);
    }, context);
    expect((await kit.agent.conversation.context(context)).head).toBeUndefined();
  } finally { summary.release(); }
  // waitForIdle excludes background tasks; wait for their durable result instead.
  await expect.poll(async () => (await kit.agent.conversation.context(context)).head?.kind).toBe("pi.compaction");
  expect(kit.faux.state.callCount).toBe(3);
});

it("a failed blocking compaction fails the run with model_error and queues at most one resume input", async () => {
  let at = Date.parse("2026-06-20T12:00:00Z");
  const kit = await open({ now: () => new Date(at), recoverEveryMs: 20 });
  // Past the faux model's 128000-token window, so every generation prepares a blocking compaction.
  for (let index = 0; index < 8; index++) {
    await kit.agent.conversation.submit({ type: "write", entry: { kind: "app.context", model: [{ role: "user", content: "Marketplace background. ".repeat(5000), timestamp: index }] } }, context);
  }
  await kit.agent.waitForIdle();
  const submit = vi.spyOn(kit.agent.conversation, "submit");
  let release = () => {};
  const gate = new Promise<void>((done) => { release = done; });
  let summaryAsked = () => {};
  const asked = new Promise<void>((done) => { summaryAsked = done; });
  kit.faux.setResponses([async () => { summaryAsked(); await gate; return fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary unavailable" }); }]);
  await kit.agent.ping();
  await asked; // The doomed generation is held by its blocking compaction's summary request.
  for (const id of ["evt-compaction-a", "evt-compaction-b"]) await kit.agent.deliver({ event_id: id, event: "task.updated", task_id: task });
  await kit.agent.recover(); // Both events queue behind the busy conversation.
  release();
  await kit.agent.waitForIdle();
  // The queued inputs drain one doomed generation each, then the passes go quiet.
  for (let pass = 0; pass < 5; pass++) { await kit.agent.recover(); await kit.agent.waitForIdle(); }
  // The run failed on its compaction with the summary error, and no pass re-runs it.
  const generations = await kit.agent.conversation.commit((tx) => tx.scanTasks({ conversationId: kit.agent.conversation.id, kind: "pi.generation" }, 50), context);
  const outcomes = JSON.stringify(generations.items);
  expect(outcomes).toContain("Compaction failed");
  expect(outcomes).toContain("summary unavailable");
  // Three model requests in total, every one a failed compaction summary: the ping
  // run, one queued event and the single resume input. Nothing spins afterwards.
  expect(kit.faux.state.callCount).toBe(3);
  expect(submit.mock.calls.filter(([draft]) => draft.requestId?.startsWith("resume:"))).toHaveLength(1);
});

it("reports a throwing commit listener through onReport and the operation it ran in still succeeds", async () => {
  const lines: string[] = [];
  const kit = await open({ log: (line) => lines.push(line) });
  const unsubscribe = kit.agent.changes(() => { throw new Error("listener exploded"); });
  try {
    await kit.agent.operator.addOrder("Check the marketplace feed twice a day");
    expect((await kit.agent.operator.state()).orders).toEqual(["Check the marketplace feed twice a day"]);
  } finally { unsubscribe(); }
  await expect.poll(() => lines.some((line) => line.includes("listener exploded"))).toBe(true);
});

it("does not allow forks to create separate marketplace policy owners", async () => {
  const kit = await open();
  kit.faux.setResponses([fauxAssistantMessage("Done")]);
  await run(kit.agent);
  const entries = await kit.agent.conversation.entries({}, 1, undefined, context);
  await expect(kit.agent.conversation.fork(entries.items[0].id, { ownership: { kind: "ownerless" } }, context)).rejects.toThrow(/forks are disabled/);
});

it("a storage error fails the session: nothing is admitted afterwards, closing still finishes and ownership is released", async () => {
  let armed = false;
  const kit = await open({ openStorage: (file) => failingStorage(file, () => armed) });
  await kit.agent.operator.setPaused(true);
  await expect(kit.agent.deliver({ event_id: "evt-fail", event: "task.updated", task_id: task })).resolves.toBeUndefined();
  // Quiesce the first admission's background reads before arming every storage
  // method. Otherwise recovery can fail first and delivery sees SessionFailed.
  await kit.agent.recover();
  armed = true;
  // A new event key forces a real commit; the deduplicated resend above would not.
  await expect(kit.agent.deliver({ event_id: "evt-fail-2", event: "task.updated", task_id: task })).rejects.toThrow(/injected storage failure/);
  expect(await kit.agent.closed).toMatchObject({ reason: "failed", error: expect.objectContaining({ message: expect.stringContaining("injected storage failure") }) });
  // Every later call refuses, so the pump can never ACK another event.
  await expect(kit.agent.deliver({ event_id: "evt-fail", event: "task.updated", task_id: task })).rejects.toThrow(/session/i);
  await expect(kit.agent.ping()).rejects.toThrow(/session/i);
  await kit.agent.close();
  expect(kit.calls).toEqual([["me"]]);
  // The failed session closed its own storage; the owner lock is free again.
  const reopened = await openAgentStorage(join(kit.dir, "state.sqlite"));
  await reopened.close(context);
});

// The real bundle `taskfast skills --yes` writes; see test/fixtures/cli/README.md.
const BUNDLE = join(import.meta.dirname, "../../test/fixtures/cli/skills/taskfast-agent");
function agentFolder(skill = true): string {
  const dir = mkdtempSync(join(tmpdir(), "marketplace-skills-"));
  dirs.push(dir);
  if (skill) cpSync(BUNDLE, join(dir, ".agents/skills/taskfast-agent"), { recursive: true });
  return dir;
}
// Records what the model was sent (system prompt, tool declarations, history) before answering.
function seen(requests: string[], message: ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory {
  return (input) => { requests.push(JSON.stringify(input)); return message; };
}

it("reads the CLI's real skill and a role reference in the durable conversation, then uses the matching tool", async () => {
  const logs: string[] = [];
  const kit = await open({ dir: agentFolder(), log: (line) => logs.push(line) });
  const requests: string[] = [];
  kit.faux.setResponses([
    seen(requests, fauxAssistantMessage([fauxToolCall("skill_read", { skill: "taskfast-agent" })], { stopReason: "toolUse" })),
    seen(requests, fauxAssistantMessage([fauxToolCall("skill_read", { skill: "taskfast-agent", file: "reference/WORKER.md" })], { stopReason: "toolUse" })),
    seen(requests, fauxAssistantMessage([fauxToolCall("me", {})], { stopReason: "toolUse" })),
    seen(requests, fauxAssistantMessage("Ready to work.")),
  ]);
  await run(kit.agent);
  expect(logs).toContain("skills: taskfast-agent");
  expect(requests[0]).toContain("skill_read");
  expect(requests[0]).toContain("- taskfast-agent: Operate as an autonomous agent on the TaskFast marketplace");
  expect(requests[0]).toContain("`taskfast bid create` is bid_create");
  expect(requests[1]).toContain("TaskFast Agent — Marketplace Skill");
  expect(requests[2]).toContain("# Worker Loop");
  expect(kit.calls).toEqual([["me"], ["me"]]);
});

it("refuses a model's path outside the skill as a tool error, and the run carries on", async () => {
  const dir = agentFolder();
  writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=agent-secret\n");
  const kit = await open({ dir });
  const requests: string[] = [];
  kit.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("skill_read", { skill: "taskfast-agent", file: "../../../.env" })], { stopReason: "toolUse" }),
    seen(requests, fauxAssistantMessage("That file is not part of the skill.")),
  ]);
  await run(kit.agent);
  expect(requests[0]).toContain("taskfast-agent has no file ../../../.env");
  expect(requests[0]).not.toContain("agent-secret");
  expect(kit.faux.state.callCount).toBe(2);
});

it("uses an approved MCP read in the durable conversation, and refuses bad arguments before the server sees them", async () => {
  const dir = agentFolder(false);
  writeMcp(dir, { docs: { command: process.execPath, args: [FIXTURE], tools: { search: approve("search") } } });
  const logs: string[] = [];
  const kit = await open({ dir, log: (line) => logs.push(line) });
  const requests: string[] = [];
  kit.faux.setResponses([
    seen(requests, fauxAssistantMessage([fauxToolCall("mcp_docs_search", { topic: "bonds" })], { stopReason: "toolUse" })),
    seen(requests, fauxAssistantMessage([fauxToolCall("mcp_docs_search", { query: "bond rules" }, { id: "second" })], { stopReason: "toolUse" })),
    seen(requests, fauxAssistantMessage("Found it.")),
  ]);
  await run(kit.agent);
  expect(logs).toContain("mcp docs: tools mcp_docs_search");
  expect(requests[0]).toContain("Tools named mcp_* come from external servers your operator approved as reads");
  // Pi checks the call against the server's schema; a call that does not fit never reaches it.
  expect(requests[1]).not.toContain("results for");
  expect(requests[1]).toContain("Validation failed for tool \\\"mcp_docs_search\\\"");
  expect(requests[2]).toContain("results for bond rules");
  expect(kit.calls).toEqual([["me"]]);
});

it("fails closed on a changed MCP tool before opening the store, and leaves no server running", async () => {
  const dir = agentFolder(false);
  const pidfile = join(dir, "grandchild.pid");
  writeMcp(dir, { docs: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_MODE: "MODE", FIXTURE_PIDFILE: "PIDFILE" }, tools: { search: approve("search") } } }, { MODE: "changed", PIDFILE: pidfile });
  const calls: string[][] = [];
  await expect(open({ dir, command: async (_runtime, args) => { calls.push(args); return me; } })).rejects.toThrow(/mcp docs: tool search \[redacted\] since you approved it/);
  expect(calls).toEqual([]);
  expect(existsSync(join(dir, "state.sqlite"))).toBe(false);
  await expectGone(Number(readFileSync(pidfile, "utf8")));
});

it("keeps two agents' same-named servers apart: own process, own credential", async () => {
  const kits = [];
  for (const secret of ["first-token", "second-token"]) {
    const dir = agentFolder(false);
    writeMcp(dir, { docs: { command: process.execPath, args: [FIXTURE], env: { DOCS_TOKEN: "DOCS_SECRET" }, tools: { env: approve("env") } } }, { DOCS_SECRET: secret });
    kits.push(await open({ dir }));
  }
  const seenBy: string[][] = [[], []];
  kits.forEach((kit, at) => kit.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("mcp_docs_env", {})], { stopReason: "toolUse" }),
    seen(seenBy[at]!, fauxAssistantMessage("Done")),
  ]));
  await Promise.all(kits.map((kit) => run(kit.agent)));
  for (const requests of seenBy) {
    expect(requests[0]).toContain("[redacted]");
    expect(requests[0]).not.toMatch(/first-token|second-token/);
  }
  await kits[0]!.agent.close();
  kits[1]!.faux.setResponses([fauxAssistantMessage([fauxToolCall("mcp_docs_env", {}, { id: "after" })], { stopReason: "toolUse" }), fauxAssistantMessage("Still here")]);
  await run(kits[1]!.agent);
  expect(kits[1]!.faux.state.callCount).toBe(4);
});

it("abandons an MCP call a restart interrupted instead of running it again", async () => {
  const dir = agentFolder(false);
  writeMcp(dir, { docs: { command: process.execPath, args: [FIXTURE], tools: { slow: approve("slow") } } });
  const first = await open({ dir });
  first.faux.setResponses([fauxAssistantMessage([fauxToolCall("mcp_docs_slow", { ms: 60_000 })], { stopReason: "toolUse" })]);
  await first.agent.ping();
  await vi.waitFor(async () => expect(JSON.stringify((await first.agent.conversation.entries({ order: "descending" }, 5, undefined, context)).items)).toContain("mcp_docs_slow"), { timeout: 2000, interval: 20 });
  await first.agent.close();
  const second = await open({ dir });
  const requests: string[] = [];
  second.faux.setResponses([seen(requests, fauxAssistantMessage("Left it."))]);
  await run(second.agent);
  expect(requests[0]).toMatch(/Tool mcp_docs_slow was not started|abandoned|interrupted/i);
});

it("keeps an agent without skills or mcp.json as before: no skill or MCP tool, no extra prompt", async () => {
  const kit = await open({ dir: agentFolder(false) });
  const requests: string[] = [];
  kit.faux.setResponses([seen(requests, fauxAssistantMessage("Done"))]);
  await run(kit.agent);
  expect(requests[0]).not.toContain("skill_read");
  expect(requests[0]).not.toContain("Skills your operator installed");
  expect(requests[0]).not.toContain("mcp_");
});

it("fails closed on a malformed skill before opening the store or asking the server anything", async () => {
  const dir = agentFolder();
  symlinkSync("/etc/passwd", join(dir, ".agents/skills/taskfast-agent/reference/passwd.md"));
  const calls: string[][] = [];
  await expect(open({ dir, command: async (_runtime, args) => { calls.push(args); return me; } })).rejects.toThrow(/taskfast-agent\/reference\/passwd\.md is a symlink/);
  expect(calls).toEqual([]);
  rmSync(join(dir, ".agents/skills/taskfast-agent/reference/passwd.md"));
  await expect(open({ dir })).resolves.toBeDefined();
});

it("answers a stored skill_read call as unavailable once the skill is removed, and keeps working", async () => {
  const dir = agentFolder();
  const first = await open({ dir });
  first.faux.setResponses([fauxAssistantMessage([fauxToolCall("skill_read", { skill: "taskfast-agent" })], { stopReason: "toolUse" }), fauxAssistantMessage("Read it.")]);
  await run(first.agent);
  await first.agent.close();
  rmSync(join(dir, ".agents"), { recursive: true });
  const second = await open({ dir });
  const requests: string[] = [];
  second.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("skill_read", { skill: "taskfast-agent" }, { id: "again" })], { stopReason: "toolUse" }),
    seen(requests, fauxAssistantMessage("No skills now.")),
  ]);
  await run(second.agent);
  expect(requests[0]).toContain("Tool skill_read is not available");
  expect(second.faux.state.callCount).toBe(2);
});
