import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, it } from "vitest";
import { MESSAGE_PREFIX, openOperatorQueue, Operator, type OperatorQueue, type OperatorQueueHost } from "./operator.js";
import { openAgentStorage } from "./storage.js";

// gh#158: the operator queue against real Pi transactions and a real SQLite store,
// without openMarketplaceAgent. Each test names the transition it pins; the table in
// docs/plans/gh158-operator-queue.md links back here.
const context = BACKGROUND_CONTEXT;
const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close(context).catch(() => {})));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function marker() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
type Kit = Awaited<ReturnType<typeof open>>;
// One store, one scripted model and one queue. `allow.value` is the host's answer to
// "may I schedule?"; `wrap` lets a test fail or gate the conversation's commits.
async function open(options: {
  dir?: string;
  faux?: ReturnType<typeof fauxProvider>;
  allow?: { value: boolean };
  wrap?: (conversation: OperatorQueueHost["conversation"]) => OperatorQueueHost["conversation"];
} = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "operator-queue-"));
  if (!dirs.includes(dir)) dirs.push(dir);
  const faux = options.faux ?? fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(await openAgentStorage(join(dir, "state.sqlite")), {
    models, registry: createRegistry(), settings: { toolExecution: "sequential" },
  }, context);
  harnesses.push(harness);
  const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "test" } } });
  const allow = options.allow ?? { value: true };
  const logs: string[] = [];
  const queue = openOperatorQueue({
    conversation: options.wrap?.(conversation) ?? conversation, read: harness, context,
    maySchedule: async () => allow.value, log: (line) => logs.push(line),
  });
  return { harness, conversation, queue, faux, allow, dir, logs };
}
// What the model was asked, oldest first: the operator's words only.
async function delivered(kit: Pick<Kit, "conversation">): Promise<string[]> {
  return (await kit.conversation.context(context)).messages.filter((message) => message.role === "user")
    .map((message) => typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""))
    .filter((content) => content.startsWith(MESSAGE_PREFIX)).map((content) => content.slice(MESSAGE_PREFIX.length));
}
// A model run that holds until released, so later operator input meets a busy conversation.
function busyRun(faux: Kit["faux"], then: string[] = []) {
  const entered = marker();
  const release = marker();
  faux.setResponses([
    async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("Finished the busy run."); },
    ...then.map((text) => fauxAssistantMessage(text)),
  ]);
  return { entered: entered.promise, release: release.resolve };
}
async function startBusy(kit: Kit, then: string[] = []) {
  const run = busyRun(kit.faux, then);
  await kit.queue.admit({ requestId: "busy", text: "Start the busy run." });
  await kit.queue.drain();
  await run.entered;
  return run;
}
async function operatorState(kit: Pick<Kit, "harness">) {
  return (await kit.harness.snapshot(Operator, context))!;
}
async function reopen(kit: Kit, options: Parameters<typeof open>[0] = {}): Promise<Kit> {
  await kit.queue.idle();
  await kit.harness.close(context);
  return open({ ...options, dir: kit.dir });
}

// Admission: request-ID dedupe.
it("buffers an admitted message once per request ID and keeps admission order", async () => {
  const kit = await open({ allow: { value: false } });
  await kit.queue.admit({ requestId: "a", text: "First." });
  await kit.queue.admit({ requestId: "b", text: "Second.", steer: true });
  await kit.queue.admit({ requestId: "a", text: "First again, must not replace." });
  expect(await kit.queue.read()).toEqual([
    { requestId: "a", text: "First.", mode: "followUp" },
    { requestId: "b", text: "Second.", mode: "steer" },
  ]);
  expect((await operatorState(kit)).queuedOrder).toEqual(["a", "b"]);
});

it("ignores a retried send once its input was delivered under the same request ID", async () => {
  const kit = await open();
  kit.faux.setResponses([fauxAssistantMessage("Done.")]);
  await kit.queue.admit({ requestId: "r1", text: "Do it." });
  await kit.queue.drain();
  await kit.conversation.waitForIdle(context);
  await kit.queue.admit({ requestId: "r1", text: "Do it." });
  expect((await operatorState(kit)).messages).toEqual([]);
  expect(await delivered(kit)).toEqual(["Do it."]);
});

// Drain: scheduling predicate and ordering.
it("holds buffered messages while the host may not schedule, then submits steers first", async () => {
  const kit = await open({ allow: { value: false } });
  await kit.queue.admit({ requestId: "follow", text: "A follow-up." });
  await kit.queue.admit({ requestId: "steer", text: "A steer.", steer: true });
  await kit.queue.drain();
  expect(kit.faux.state.callCount).toBe(0);
  expect((await operatorState(kit)).messages.map((message) => message.requestId).sort()).toEqual(["follow", "steer"]);
  kit.allow.value = true;
  kit.faux.setResponses([fauxAssistantMessage("Steer handled."), fauxAssistantMessage("Follow-up handled.")]);
  await kit.queue.drain();
  await kit.conversation.waitForIdle(context);
  expect(await delivered(kit)).toEqual(["A steer.", "A follow-up."]);
  expect(await kit.queue.read()).toEqual([]);
  // A drain prunes the order of messages Pi has since placed.
  await kit.queue.drain();
  expect((await operatorState(kit)).queuedOrder).toEqual([]);
});

it("checks the host before every submission, so a pause mid-drain leaves the rest buffered", async () => {
  let checks = 0;
  const kit = await open({ allow: { get value() { return ++checks <= 1; }, set value(_) {} } });
  await kit.queue.admit({ requestId: "one", text: "One." });
  await kit.queue.admit({ requestId: "two", text: "Two." });
  kit.faux.setResponses([fauxAssistantMessage("Handled one.")]);
  await kit.queue.drain();
  await kit.conversation.waitForIdle(context);
  expect(await delivered(kit)).toEqual(["One."]);
  expect((await operatorState(kit)).messages.map((message) => message.requestId)).toEqual(["two"]);
  expect(await kit.queue.read()).toEqual([{ requestId: "two", text: "Two.", mode: "followUp" }]);
});

// Withdrawal: placement race, tombstone, atomicity.
it("withdraws a buffered message with a permanent tombstone that a retried send cannot undo", async () => {
  const kit = await open({ allow: { value: false } });
  await kit.queue.admit({ requestId: "gone", text: "Never mind." });
  expect(await kit.queue.withdraw("gone")).toBe("withdrawn");
  expect(await kit.queue.withdraw("gone")).toBe("withdrawn");
  await kit.queue.admit({ requestId: "gone", text: "Never mind." });
  expect(await kit.queue.read()).toEqual([]);
  expect(await kit.queue.withdraw("never-sent")).toBe("not_found");
  const reopened = await reopen(kit, { allow: { value: true } });
  await reopened.queue.admit({ requestId: "gone", text: "Never mind." });
  await reopened.queue.drain();
  expect(reopened.faux.state.callCount).toBe(0);
  expect((await operatorState(reopened)).withdrawn).toEqual({ gone: true });
});

it("withdraws a Pi-queued follow-up but refuses one the agent already has", async () => {
  const kit = await open();
  const run = await startBusy(kit, ["After the busy run."]);
  await kit.queue.admit({ requestId: "later", text: "Later." });
  await kit.queue.drain();
  expect(await kit.queue.read()).toEqual([{ requestId: "later", text: "Later.", mode: "followUp" }]);
  expect(await kit.queue.withdraw("busy")).toBe("already_placed");
  expect(await kit.queue.withdraw("later")).toBe("withdrawn");
  expect(await kit.queue.read()).toEqual([]);
  run.release();
  await kit.conversation.waitForIdle(context);
  expect(await delivered(kit)).toEqual(["Start the busy run."]);
  await kit.queue.admit({ requestId: "later", text: "Later." });
  await kit.queue.drain();
  expect(await delivered(kit)).toEqual(["Start the busy run."]);
});

it("reports already_placed when a withdrawal loses to placement, never a false withdrawal", async () => {
  const kit = await open();
  const run = await startBusy(kit, ["Handled the follow-up."]);
  await kit.queue.admit({ requestId: "race", text: "Race me." });
  await kit.queue.drain();
  run.release();
  await kit.conversation.waitForIdle(context);
  expect(await kit.queue.withdraw("race")).toBe("already_placed");
  expect(await delivered(kit)).toEqual(["Start the busy run.", "Race me."]);
});

it("commits nothing when a withdrawal's commit fails, and the message survives a reopen", async () => {
  let fail = false;
  const kit = await open({
    allow: { value: false },
    wrap: (conversation) => ({
      id: conversation.id, submit: conversation.submit.bind(conversation),
      commit: (change, ctx) => conversation.commit(async (tx) => {
        const result = await change(tx);
        if (fail) throw new Error("commit refused");
        return result;
      }, ctx),
    }),
  });
  await kit.queue.admit({ requestId: "keep", text: "Keep me." });
  fail = true;
  await expect(kit.queue.withdraw("keep")).rejects.toThrow("commit refused");
  fail = false;
  expect(await kit.queue.read()).toEqual([{ requestId: "keep", text: "Keep me.", mode: "followUp" }]);
  expect((await operatorState(kit)).withdrawn).toBeUndefined();
  const reopened = await reopen(kit, { allow: { value: false } });
  expect(await reopened.queue.read()).toEqual([{ requestId: "keep", text: "Keep me.", mode: "followUp" }]);
  expect(await reopened.queue.withdraw("keep")).toBe("withdrawn");
});

// Promotion: intent before abort, one delivery.
it("promotes a buffered follow-up in place and reports unknown requests as not found", async () => {
  const kit = await open({ allow: { value: false } });
  await kit.queue.admit({ requestId: "a", text: "A." });
  await kit.queue.admit({ requestId: "b", text: "B." });
  expect(await kit.queue.promote("b")).toBe("steered");
  expect(await kit.queue.promote("b")).toBe("steered");
  expect(await kit.queue.promote("unknown")).toBe("not_found");
  expect(await kit.queue.read()).toEqual([
    { requestId: "a", text: "A.", mode: "followUp" },
    { requestId: "b", text: "B.", mode: "steer" },
  ]);
  expect((await operatorState(kit)).pendingSteers ?? {}).toEqual({});
});

it("promotes a Pi-queued follow-up exactly once, including concurrent promotions", async () => {
  const kit = await open();
  const run = await startBusy(kit, ["Applied the correction."]);
  await kit.queue.admit({ requestId: "fix", text: "Use the revised guide." });
  await kit.queue.drain();
  expect(await Promise.all([kit.queue.promote("fix"), kit.queue.promote("fix")])).toEqual(["steered", "steered"]);
  expect(await kit.queue.read()).toEqual([{ requestId: "fix", text: "Use the revised guide.", mode: "steer" }]);
  expect((await operatorState(kit)).pendingSteers ?? {}).toEqual({});
  await kit.queue.admit({ requestId: "fix", text: "Use the revised guide." });
  run.release();
  await kit.conversation.waitForIdle(context);
  expect(await delivered(kit)).toEqual(["Start the busy run.", "Use the revised guide."]);
});

it("keeps a promotion's intent and defers its replacement while the host may not schedule", async () => {
  const kit = await open();
  const run = await startBusy(kit, ["Applied the correction."]);
  await kit.queue.admit({ requestId: "fix", text: "Use the revised guide." });
  await kit.queue.drain();
  kit.allow.value = false;
  expect(await kit.queue.promote("fix")).toBe("steered");
  expect(Object.keys((await operatorState(kit)).pendingSteers ?? {})).toEqual(["fix"]);
  expect(await kit.queue.read()).toEqual([{ requestId: "fix", text: "Use the revised guide.", mode: "steer" }]);
  kit.allow.value = true;
  await kit.queue.recoverSteers();
  expect((await operatorState(kit)).pendingSteers ?? {}).toEqual({});
  run.release();
  await kit.conversation.waitForIdle(context);
  expect(await delivered(kit)).toEqual(["Start the busy run.", "Use the revised guide."]);
});

it("logs, and still reports steered, when recovery fails after the promotion intent is durable", async () => {
  let failSubmit = false;
  const kit = await open({
    wrap: (conversation) => ({
      id: conversation.id, commit: conversation.commit.bind(conversation),
      submit: (draft, ctx) => {
        if (failSubmit && draft.requestId?.startsWith("operator-steer:")) throw new Error("submit refused");
        return conversation.submit(draft, ctx);
      },
    }),
  });
  const run = await startBusy(kit, ["After."]);
  await kit.queue.admit({ requestId: "fix", text: "Use the revised guide." });
  await kit.queue.drain();
  failSubmit = true;
  expect(await kit.queue.promote("fix")).toBe("steered");
  expect(kit.logs.join("\n")).toContain("operator steer recovery: Error: submit refused");
  expect(Object.keys((await operatorState(kit)).pendingSteers ?? {})).toEqual(["fix"]);
  failSubmit = false;
  await kit.queue.recoverSteers();
  expect((await operatorState(kit)).pendingSteers ?? {}).toEqual({});
  run.release();
  await kit.conversation.waitForIdle(context);
  expect(await delivered(kit)).toEqual(["Start the busy run.", "Use the revised guide."]);
});

it("reports already_placed for a promotion intent that lost the placement race", async () => {
  const kit = await open();
  const run = await startBusy(kit, ["Handled."]);
  const original = await kit.conversation.submit({ type: "input", requestId: "operator:placed", content: MESSAGE_PREFIX + "Review this.", whenBusy: "followUp" }, context);
  await kit.conversation.commit(async (tx) => {
    (await tx.doc(Operator)).pendingSteers = { placed: { submission: original.id, text: "Review this." } };
  }, context);
  run.release();
  await kit.conversation.waitForIdle(context);
  await kit.queue.recoverSteers();
  expect((await operatorState(kit)).pendingSteers ?? {}).toEqual({});
  expect(await delivered(kit)).toEqual(["Start the busy run.", "Review this."]);
  expect(await kit.queue.read()).toEqual([]);
});

// Restart recovery: each interrupted promotion stage, against one reopened store.
for (const stage of ["intent", "aborted", "admitted"] as const) {
  it(`recovers a promotion interrupted after ${stage} without delivering twice`, async () => {
    const entered = marker();
    const release = marker();
    const kit = await open();
    // The busy run fails, so the original follow-up stays queued when it ends.
    kit.faux.setResponses([async () => {
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Leave the follow-up queued." });
    }, fauxAssistantMessage("Replacement handled before the interruption.")]);
    await kit.conversation.submit({ type: "input", requestId: "first", content: "Begin." }, context);
    await entered.promise;
    const original = await kit.conversation.submit({ type: "input", requestId: "operator:crash", content: MESSAGE_PREFIX + "Recover this.", whenBusy: "followUp" }, context);
    await kit.conversation.commit(async (tx) => {
      const state = await tx.doc(Operator);
      state.queuedOrder = ["crash"];
      state.pendingSteers = { crash: { submission: original.id, text: "Recover this." } };
    }, context);
    release.resolve();
    await kit.conversation.waitForIdle(context);
    expect((await original.status(context)).status).toBe("queued");
    if (stage !== "intent") expect(await original.abort(context)).toBe("aborted");
    if (stage === "admitted") {
      await kit.conversation.submit({ type: "input", requestId: "operator-steer:crash", content: MESSAGE_PREFIX + "Recover this.", whenBusy: "steer" }, context);
      await kit.conversation.waitForIdle(context);
    }
    expect(await kit.queue.read()).toEqual([{ requestId: "crash", text: "Recover this.", mode: "steer" }]);
    await kit.harness.close(context);
    const reopened = await open({ dir: kit.dir });
    reopened.faux.setResponses([fauxAssistantMessage("Recovered the correction.")]);
    await reopened.queue.recoverSteers();
    await reopened.conversation.waitForIdle(context);
    expect((await operatorState(reopened)).pendingSteers ?? {}).toEqual({});
    expect(await reopened.queue.read()).toEqual([]);
    expect(await delivered(reopened)).toEqual(["Recover this."]);
    expect(reopened.faux.state.callCount).toBe(stage === "admitted" ? 0 : 1);
    // A retried send of either request ID dedupes into the stored submission.
    expect((await reopened.conversation.submit({ type: "input", requestId: "operator:crash", content: MESSAGE_PREFIX + "Recover this.", whenBusy: "followUp" }, context)).id).toBe(original.id);
  });
}

// Legacy v1 documents.
it("reads a version 1 document without mode, order or intent fields", async () => {
  const kit = await open({ allow: { value: false } });
  await kit.conversation.commit(async (tx) => {
    (await tx.doc(Operator)).messages.push({ requestId: "legacy", text: "Legacy follow-up." });
  }, context);
  expect(await kit.queue.read()).toEqual([{ requestId: "legacy", text: "Legacy follow-up.", mode: "followUp" }]);
  expect(await kit.queue.promote("legacy")).toBe("steered");
  const reopened = await reopen(kit, { allow: { value: false } });
  expect(await reopened.queue.read()).toEqual([{ requestId: "legacy", text: "Legacy follow-up.", mode: "steer" }]);
});

// Idle barrier and store ownership.
it("does not report idle until an admission in flight has committed", async () => {
  const gate = marker();
  const kit = await open({
    allow: { value: false },
    wrap: (conversation) => ({
      id: conversation.id, submit: conversation.submit.bind(conversation),
      commit: async (change, ctx) => { await gate.promise; return conversation.commit(change, ctx); },
    }),
  });
  let idle = false;
  const admitted = kit.queue.admit({ requestId: "slow", text: "Slow." });
  void kit.queue.idle().then(() => { idle = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(idle).toBe(false);
  gate.resolve();
  await admitted;
  await kit.queue.idle();
  expect(idle).toBe(true);
});

it("keeps the store owned by one handle while the queue is open, and frees it on close", async () => {
  const kit = await open({ allow: { value: false } });
  await kit.queue.admit({ requestId: "a", text: "A." });
  await expect(openAgentStorage(join(kit.dir, "state.sqlite"))).rejects.toThrow(/already owned/);
  const reopened = await reopen(kit, { allow: { value: false } });
  expect(await reopened.queue.read()).toEqual([{ requestId: "a", text: "A.", mode: "followUp" }]);
});
