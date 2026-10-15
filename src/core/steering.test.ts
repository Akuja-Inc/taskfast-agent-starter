import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it } from "vitest";
import { openMarketplaceAgent, type MarketplaceAgent } from "./agent.js";
import type { CliResult } from "./cli.js";
import { MESSAGE_PREFIX, Operator } from "./operator.js";
import { parseAgentSpec } from "./spec.js";
import { example } from "../../test/example.js";

const context = BACKGROUND_CONTEXT;
const dirs: string[] = [];
const opened: MarketplaceAgent[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((agent) => agent.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function marker() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function open(options: {
  dir?: string;
  faux?: ReturnType<typeof fauxProvider>;
  command?: (args: string[]) => Promise<CliResult>;
} = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "steering-"));
  if (!dirs.includes(dir)) dirs.push(dir);
  const faux = options.faux ?? fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const value: unknown = example("brisk-poster");
  const agent = await openMarketplaceAgent({
    storePath: join(dir, "state.sqlite"),
    spec: { ...parseAgentSpec(value), model: "faux:test" },
    runtime: { env: "staging", configPath: join(dir, "config.json") },
    models, recoverEveryMs: 60_000,
    command: async (_runtime, args): Promise<CliResult> => {
      if (args[0] === "me") return { outcome: "ok", data: { profile: { id: "33333333-3333-4333-8333-333333333333" } } };
      return options.command ? options.command(args) : { outcome: "ok", data: {} };
    },
  });
  opened.push(agent);
  return { agent, faux, dir };
}
async function operatorInputs(agent: MarketplaceAgent) {
  return (await agent.transcript(200)).filter((message) => message.role === "user")
    .map((message) => typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""))
    .filter((content) => content.startsWith(MESSAGE_PREFIX));
}

it("promotes a busy follow-up once, including concurrent promotions and original-send retries", async () => {
  const entered = marker();
  const release = marker();
  const kit = await open({ command: async () => { entered.resolve(); await release.promise; return { outcome: "ok", data: {} }; } });
  const prompts: string[] = [];
  kit.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("wallet_balance", {})], { stopReason: "toolUse" }),
    (ctx) => { prompts.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage("Applied the correction in the same run."); },
    fauxAssistantMessage("This extra run must not happen."),
  ]);
  await kit.agent.ping();
  await entered.promise;
  try {
    await kit.agent.operator.message({ requestId: "correction", text: "Use the revised guide." });
    expect(await kit.agent.operator.queued()).toEqual([{ requestId: "correction", text: "Use the revised guide.", mode: "followUp" }]);
    expect(await Promise.all([kit.agent.operator.steer("correction"), kit.agent.operator.steer("correction")])).toEqual(["steered", "steered"]);
    await kit.agent.operator.message({ requestId: "correction", text: "Use the revised guide." });
    expect(await kit.agent.operator.queued()).toEqual([{ requestId: "correction", text: "Use the revised guide.", mode: "steer" }]);
  } finally { release.resolve(); }
  await kit.agent.waitForIdle();
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("Use the revised guide.");
  expect(await operatorInputs(kit.agent)).toEqual([MESSAGE_PREFIX + "Use the revised guide."]);
  expect(kit.faux.state.callCount).toBe(2);
  expect(await kit.agent.operator.queued()).toEqual([]);
});

it("starts a direct steer while idle and rejects an unknown or finished promotion", async () => {
  const kit = await open();
  kit.faux.setResponses([fauxAssistantMessage("Acted on the idle steer.")]);
  expect(await kit.agent.operator.steer("unknown")).toBe("not_found");
  await kit.agent.operator.message({ requestId: "idle", text: "Check the revised guide now.", steer: true });
  await kit.agent.waitForIdle();
  expect(await operatorInputs(kit.agent)).toEqual([MESSAGE_PREFIX + "Check the revised guide now."]);
  expect(kit.faux.state.callCount).toBe(1);
  expect(await kit.agent.operator.steer("idle")).toBe("not_found");
  expect(await kit.agent.operator.queued()).toEqual([]);
});

it("reports a promotion intent that lost the placement race without duplicating its input", async () => {
  const entered = marker();
  const release = marker();
  const kit = await open();
  kit.faux.setResponses([
    async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("Finished the busy run."); },
    fauxAssistantMessage("Already handled the follow-up."),
  ]);
  await kit.agent.ping();
  await entered.promise;
  try {
    const original = await kit.agent.conversation.submit({
      type: "input", requestId: "operator:placed", content: MESSAGE_PREFIX + "Review this guide.", whenBusy: "followUp",
    }, context);
    // The process can lose the placement race after intent admission, before abort.
    await kit.agent.conversation.commit(async (tx) => {
      (await tx.doc(Operator)).pendingSteers = { placed: { submission: original.id, text: "Review this guide." } };
    }, context);
  } finally { release.resolve(); }
  await kit.agent.waitForIdle();
  expect(await kit.agent.operator.steer("placed")).toBe("already_placed");
  expect(await kit.agent.operator.queued()).toEqual([]);
  expect(await operatorInputs(kit.agent)).toEqual([MESSAGE_PREFIX + "Review this guide."]);
  expect((await kit.agent.operator.state()).pendingSteers ?? {}).toEqual({});
  expect(kit.faux.state.callCount).toBe(2);
});

it("shows only unplaced operator messages, oldest first through promotion", async () => {
  const entered = marker();
  const release = marker();
  const kit = await open({ command: async () => { entered.resolve(); await release.promise; return { outcome: "ok", data: {} }; } });
  kit.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("wallet_balance", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished the busy work."),
    fauxAssistantMessage("Handled queued work."),
  ]);
  await kit.agent.ping();
  await entered.promise;
  try {
    await kit.agent.deliver({ event_id: "hidden-event", event: "message_received" });
    await kit.agent.recover();
    await kit.agent.conversation.submit({ type: "input", requestId: "resume:fixture", content: "Resume host work.", whenBusy: "followUp" }, context);
    await kit.agent.operator.message({ requestId: "older", text: "Older follow-up." });
    await kit.agent.operator.message({ requestId: "newer", text: "Newer steer.", steer: true });
    expect(await kit.agent.operator.steer("older")).toBe("steered");
    expect(await kit.agent.operator.queued()).toEqual([
      { requestId: "older", text: "Older follow-up.", mode: "steer" },
      { requestId: "newer", text: "Newer steer.", mode: "steer" },
    ]);
  } finally { release.resolve(); }
  await kit.agent.waitForIdle();
  expect(await kit.agent.operator.queued()).toEqual([]);
});

it("keeps legacy Pi inbox order when an older follow-up is promoted", async () => {
  const entered = marker();
  const release = marker();
  const kit = await open({ command: async () => { entered.resolve(); await release.promise; return { outcome: "ok", data: {} }; } });
  kit.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("wallet_balance", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Applied the correction."),
    fauxAssistantMessage("Handled the later follow-up."),
  ]);
  await kit.agent.ping();
  await entered.promise;
  try {
    // Existing v1 stores can have queued Pi messages but no queuedOrder metadata.
    await kit.agent.conversation.submit({ type: "input", requestId: "operator:legacy-older", content: MESSAGE_PREFIX + "Oldest legacy input.", whenBusy: "followUp" }, context);
    await kit.agent.conversation.submit({ type: "input", requestId: "operator:legacy-newer", content: MESSAGE_PREFIX + "Later legacy input.", whenBusy: "followUp" }, context);
    expect(await kit.agent.operator.queued()).toEqual([
      { requestId: "legacy-older", text: "Oldest legacy input.", mode: "followUp" },
      { requestId: "legacy-newer", text: "Later legacy input.", mode: "followUp" },
    ]);
    expect(await kit.agent.operator.steer("legacy-older")).toBe("steered");
    expect(await kit.agent.operator.queued()).toEqual([
      { requestId: "legacy-older", text: "Oldest legacy input.", mode: "steer" },
      { requestId: "legacy-newer", text: "Later legacy input.", mode: "followUp" },
    ]);
  } finally { release.resolve(); }
  await kit.agent.waitForIdle();
  expect(await operatorInputs(kit.agent)).toEqual([MESSAGE_PREFIX + "Oldest legacy input.", MESSAGE_PREFIX + "Later legacy input."]);
});

it("keeps buffered modes, legacy follow-ups and admission order across a paused reopen", async () => {
  const kit = await open();
  await kit.agent.operator.setPaused(true);
  // An unchanged v1 document can contain messages written before mode/order existed.
  await kit.agent.conversation.commit(async (tx) => {
    (await tx.doc(Operator)).messages.push({ requestId: "legacy", text: "Legacy follow-up." });
  }, context);
  await kit.agent.operator.message({ requestId: "first", text: "First admitted follow-up." });
  await kit.agent.operator.message({ requestId: "second", text: "Second admitted steer.", steer: true });
  await kit.agent.operator.message({ requestId: "third", text: "Third admitted follow-up." });
  expect(await kit.agent.operator.steer("third")).toBe("steered");
  const expected = [
    { requestId: "legacy", text: "Legacy follow-up.", mode: "followUp" },
    { requestId: "first", text: "First admitted follow-up.", mode: "followUp" },
    { requestId: "second", text: "Second admitted steer.", mode: "steer" },
    { requestId: "third", text: "Third admitted follow-up.", mode: "steer" },
  ];
  expect(await kit.agent.operator.queued()).toEqual(expected);
  expect(kit.faux.state.callCount).toBe(0);
  await kit.agent.close();
  const reopened = await open({ dir: kit.dir });
  expect(await reopened.agent.operator.queued()).toEqual(expected);
  expect(reopened.faux.state.callCount).toBe(0);
  reopened.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("Handled the message.")));
  await reopened.agent.operator.setPaused(false);
  await reopened.agent.waitForIdle();
  expect(await operatorInputs(reopened.agent)).toEqual([
    MESSAGE_PREFIX + "Second admitted steer.", MESSAGE_PREFIX + "Third admitted follow-up.",
    MESSAGE_PREFIX + "Legacy follow-up.", MESSAGE_PREFIX + "First admitted follow-up.",
  ]);
  expect(await reopened.agent.operator.queued()).toEqual([]);
});

// Build each interrupted boundary with Pi's own submissions and explicit durable
// document commits. Every case closes and reopens one store, never a copied store.
for (const stage of ["intent", "aborted", "admitted"] as const) {
  it(`recovers promotion after ${stage} is committed without delivering twice`, async () => {
    const entered = marker();
    const release = marker();
    const kit = await open();
    kit.faux.setResponses([async () => {
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Leave the follow-up queued." });
    }, fauxAssistantMessage("Replacement handled before the interruption.")]);
    await kit.agent.ping();
    await entered.promise;
    const original = await kit.agent.conversation.submit({
      type: "input", requestId: "operator:crash-note", content: MESSAGE_PREFIX + "Recover this correction.", whenBusy: "followUp",
    }, context);
    await kit.agent.conversation.commit(async (tx) => {
      const state = await tx.doc(Operator);
      state.queuedOrder = ["crash-note"];
      state.pendingSteers = { "crash-note": { submission: original.id, text: "Recover this correction." } };
    }, context);
    release.resolve();
    await kit.agent.waitForIdle();
    expect((await original.status(context)).status).toBe("queued");
    if (stage !== "intent") {
      expect(await original.abort(context)).toBe("aborted");
      // Pi 1.1.0 says settled on a retry. Recovery must inspect the saved record.
      expect(await original.abort(context)).toBe("settled");
      expect(await original.status(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
      expect((await original.status(context)).entry).toBeUndefined();
    }
    if (stage === "admitted") {
      await kit.agent.conversation.submit({
        type: "input", requestId: "operator-steer:crash-note", content: MESSAGE_PREFIX + "Recover this correction.", whenBusy: "steer",
      }, context);
      await kit.agent.waitForIdle();
      expect(await operatorInputs(kit.agent)).toEqual([MESSAGE_PREFIX + "Recover this correction."]);
    }
    await kit.agent.close();
    const faux = fauxProvider({ models: [{ id: "test" }] });
    const prompts: string[] = [];
    faux.setResponses([(ctx) => { prompts.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage("Recovered the correction."); }]);
    const reopened = await open({ dir: kit.dir, faux });
    await reopened.agent.waitForIdle();
    await reopened.agent.recover();
    await reopened.agent.waitForIdle();
    expect(await operatorInputs(reopened.agent)).toEqual([MESSAGE_PREFIX + "Recover this correction."]);
    expect(faux.state.callCount).toBe(stage === "admitted" ? 0 : 1);
    if (stage !== "admitted") expect(prompts[0]).toContain("Recover this correction.");
    expect((await reopened.agent.operator.state()).pendingSteers ?? {}).toEqual({});
    expect(await reopened.agent.operator.queued()).toEqual([]);
    const duplicateOriginal = await reopened.agent.conversation.submit({
      type: "input", requestId: "operator:crash-note", content: MESSAGE_PREFIX + "Recover this correction.", whenBusy: "followUp",
    }, context);
    expect(duplicateOriginal.id).toBe(original.id);
    expect(await duplicateOriginal.status(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
    const duplicateReplacement = await reopened.agent.conversation.submit({
      type: "input", requestId: "operator-steer:crash-note", content: MESSAGE_PREFIX + "Recover this correction.", whenBusy: "steer",
    }, context);
    expect((await duplicateReplacement.status(context)).status).toBe("done");
  });
}

it("withdraws a paused promotion but defers its replacement across reopen until resume", async () => {
  const entered = marker();
  const release = marker();
  const kit = await open({ command: async () => { entered.resolve(); await release.promise; return { outcome: "ok", data: {} }; } });
  kit.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("wallet_balance", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished only the already running work."),
  ]);
  await kit.agent.ping();
  await entered.promise;
  try {
    await kit.agent.operator.message({ requestId: "paused", text: "Wait until I resume." });
    await kit.agent.operator.setPaused(true);
    expect(await kit.agent.operator.steer("paused")).toBe("steered");
    expect(await kit.agent.operator.queued()).toEqual([{ requestId: "paused", text: "Wait until I resume.", mode: "steer" }]);
    expect((await kit.agent.operator.state()).pendingSteers?.paused).toMatchObject({ text: "Wait until I resume." });
  } finally { release.resolve(); }
  await kit.agent.waitForIdle();
  expect(await operatorInputs(kit.agent)).toEqual([]);
  await kit.agent.close();
  const reopened = await open({ dir: kit.dir });
  expect(reopened.faux.state.callCount).toBe(0);
  expect(await reopened.agent.operator.queued()).toEqual([{ requestId: "paused", text: "Wait until I resume.", mode: "steer" }]);
  expect(await reopened.agent.operator.steer("paused")).toBe("steered");
  await reopened.agent.operator.message({ requestId: "paused", text: "Wait until I resume." });
  reopened.faux.setResponses([fauxAssistantMessage("Handled after resume.")]);
  await reopened.agent.operator.setPaused(false);
  await reopened.agent.waitForIdle();
  expect(await operatorInputs(reopened.agent)).toEqual([MESSAGE_PREFIX + "Wait until I resume."]);
  expect(reopened.faux.state.callCount).toBe(1);
  expect((await reopened.agent.operator.state()).pendingSteers ?? {}).toEqual({});
});

it("makes queued operator work progress after the busy model run fails", async () => {
  const entered = marker();
  const release = marker();
  const kit = await open();
  const prompts: string[] = [];
  kit.faux.setResponses([
    async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Busy run failed." }); },
    (ctx) => { prompts.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage("Recovered the busy run."); },
    (ctx) => { prompts.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage("Handled the follow-up."); },
  ]);
  await kit.agent.ping();
  await entered.promise;
  try {
    await kit.agent.operator.message({ requestId: "after-failure", text: "Do not strand this follow-up." });
  } finally { release.resolve(); }
  await kit.agent.waitForIdle();
  expect(await kit.agent.operator.queued()).toEqual([{ requestId: "after-failure", text: "Do not strand this follow-up.", mode: "followUp" }]);
  await kit.agent.recover();
  await kit.agent.waitForIdle();
  expect(prompts.some((prompt) => prompt.includes("Do not strand this follow-up."))).toBe(true);
  expect(await operatorInputs(kit.agent)).toEqual([MESSAGE_PREFIX + "Do not strand this follow-up."]);
  expect(await kit.agent.operator.queued()).toEqual([]);
});
