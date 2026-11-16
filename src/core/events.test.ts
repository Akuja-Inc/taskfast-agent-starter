import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, it } from "vitest";
import { EVENT_RETRY, openEventWork, type EventWorkHost } from "./events.js";
import { openAgentStorage } from "./storage.js";

// The event machine against real Pi submissions and persistent SQLite, not a marketplace agent.
const context = BACKGROUND_CONTEXT;
const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close(context).catch(() => {})));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const event = (id: string) => ({ event_id: id, event: "message_received" });
const failure = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "scripted model failure" });
function marker() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function open(options: {
  dir?: string;
  clock?: { at: number };
  maySchedule?: () => Promise<boolean>;
  wrap?: (conversation: EventWorkHost["conversation"]) => EventWorkHost["conversation"];
} = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "event-work-"));
  if (!dirs.includes(dir)) dirs.push(dir);
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(await openAgentStorage(join(dir, "state.sqlite")), {
    models, registry: createRegistry(), settings: { toolExecution: "sequential" },
  }, context);
  harnesses.push(harness);
  const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "test" } } });
  const clock = options.clock ?? { at: Date.parse("2026-06-20T12:00:00Z") };
  const logs: string[] = [];
  const work = await openEventWork({
    conversation: options.wrap?.(conversation) ?? conversation, read: harness, context,
    now: () => clock.at, log: (line) => logs.push(line), maySchedule: options.maySchedule ?? (async () => true),
  });
  return { dir, faux, harness, conversation, clock, logs, work };
}

it("initializes an empty document and admits one JSON snapshot per event ID", async () => {
  const kit = await open();
  expect(await kit.work.read()).toEqual({});
  const input = { ...event("one"), data: { message: "Original." } };
  await kit.work.admit(input);
  input.data.message = "Changed.";
  await kit.work.admit(input);
  const admitted = await kit.work.read();
  expect(admitted).toEqual({
    "event:one": { kind: "admitted", attempt: 0, event: { ...event("one"), data: { message: "Original." } } },
  });
  expect(kit.faux.state.callCount).toBe(0);
  await kit.harness.close(context);
  const reopened = await open({ dir: kit.dir });
  expect(await reopened.work.read()).toEqual(admitted);
});

it("refuses invalid events before committing admission", async () => {
  const kit = await open();
  await expect(kit.work.admit({ event_id: "", event: "message_received" })).rejects.toThrow("event refused:");
  expect(await kit.work.read()).toEqual({});
});

it("holds admitted events and rechecks scheduling before every submission", async () => {
  let checks = 0;
  let allowed = false;
  const kit = await open({ maySchedule: async () => allowed && ++checks === 1 });
  kit.faux.setResponses([fauxAssistantMessage("Handled.")]);
  await kit.work.admit(event("first"));
  await kit.work.admit(event("second"));
  await kit.work.advance();
  expect(kit.faux.state.callCount).toBe(0);
  allowed = true;
  await kit.work.advance();
  await kit.conversation.waitForIdle(context);
  expect(checks).toBe(2);
  expect((await kit.work.read())["event:first"].kind).toBe("submitted");
  expect((await kit.work.read())["event:second"].kind).toBe("admitted");
  expect(kit.faux.state.callCount).toBe(1);
});

it("marks completed work done and never resubmits it, including after reopen", async () => {
  const kit = await open();
  kit.faux.setResponses([fauxAssistantMessage("Done.")]);
  await kit.work.admit(event("done"));
  await kit.work.advance();
  await kit.conversation.waitForIdle(context);
  await kit.work.advance();
  expect((await kit.work.read())["event:done"].kind).toBe("done");
  await kit.work.advance();
  expect(kit.faux.state.callCount).toBe(1);
  await kit.harness.close(context);
  const reopened = await open({ dir: kit.dir });
  await reopened.work.admit(event("done"));
  await reopened.work.advance();
  expect(reopened.faux.state.callCount).toBe(0);
});

it("leaves queued and placed submissions alone until their runs settle", async () => {
  const kit = await open();
  const entered = marker();
  const release = marker();
  kit.faux.setResponses([
    async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("First handled."); },
    fauxAssistantMessage("Second handled."),
  ]);
  await kit.work.admit(event("first"));
  await kit.work.admit(event("second"));
  try {
    await kit.work.advance();
    await entered.promise;
    const before = await kit.work.read();
    const records = await kit.harness.inspect(context);
    expect(records.submissions.map((record) => record.status).sort()).toEqual(["placed", "queued"]);
    await kit.work.advance();
    expect(await kit.work.read()).toEqual(before);
    expect(kit.faux.state.callCount).toBe(1);
  } finally { release.resolve(); }
  await kit.conversation.waitForIdle(context);
  await kit.work.advance();
  expect(Object.values(await kit.work.read()).map((work) => work.kind)).toEqual(["done", "done"]);
  expect(kit.faux.state.callCount).toBe(2);
});

it("persists growing jittered backoff across reopening, caps retries and logs abandonment once", async () => {
  let kit = await open();
  const clock = kit.clock;
  kit.faux.setResponses([failure]);
  await kit.work.admit(event("failing"));
  await kit.work.advance();
  await kit.conversation.waitForIdle(context);
  for (let attempt = 0; attempt < EVENT_RETRY.retries; attempt++) {
    const failedAt = clock.at;
    await kit.work.advance();
    const retry = (await kit.work.read())["event:failing"];
    expect(retry.kind).toBe("admitted");
    if (retry.kind !== "admitted") throw new Error("expected a retry");
    const base = EVENT_RETRY.minTimeout * EVENT_RETRY.factor ** attempt;
    expect(retry.notBefore).toBeGreaterThanOrEqual(failedAt + Math.min(base, EVENT_RETRY.maxTimeout));
    expect(retry.notBefore).toBeLessThanOrEqual(failedAt + Math.min(2 * base, EVENT_RETRY.maxTimeout));
    expect(retry.attempt).toBe(attempt + 1);
    await kit.harness.close(context);
    kit = await open({ dir: kit.dir, clock });
    expect((await kit.work.read())["event:failing"]).toEqual(retry);
    kit.faux.setResponses([failure]);
    clock.at = retry.notBefore! - 1;
    await kit.work.advance();
    expect(kit.faux.state.callCount).toBe(0);
    clock.at++;
    await kit.work.advance();
    await kit.conversation.waitForIdle(context);
    expect(kit.faux.state.callCount).toBe(1);
  }
  await kit.work.advance();
  await kit.work.advance();
  expect((await kit.work.read())["event:failing"]).toMatchObject({ kind: "abandoned", attempt: EVENT_RETRY.retries });
  expect(kit.logs).toEqual([`event:failing abandoned after ${EVENT_RETRY.retries + 1} failed model runs`]);
  await kit.harness.close(context);
  kit = await open({ dir: kit.dir, clock });
  await kit.work.advance();
  expect(kit.faux.state.callCount).toBe(0);
  expect(kit.logs).toEqual([]);
  await kit.work.retry("failing");
  expect((await kit.work.read())["event:failing"]).toMatchObject({ kind: "admitted", attempt: EVENT_RETRY.retries + 1 });
  kit.faux.setResponses([failure]);
  await kit.work.advance();
  await kit.conversation.waitForIdle(context);
  await kit.work.advance();
  expect((await kit.work.read())["event:failing"].kind).toBe("abandoned");
  expect(kit.logs).toEqual([`event:failing abandoned after ${EVENT_RETRY.retries + 2} failed model runs`]);
});

it("refuses retry for missing, admitted, submitted and done events", async () => {
  const kit = await open();
  await expect(kit.work.retry("missing")).rejects.toThrow("event missing is not abandoned");
  await kit.work.admit(event("one"));
  await expect(kit.work.retry("one")).rejects.toThrow("not abandoned");
  kit.faux.setResponses([fauxAssistantMessage("Done.")]);
  await kit.work.advance();
  await expect(kit.work.retry("one")).rejects.toThrow("not abandoned");
  await kit.conversation.waitForIdle(context);
  await kit.work.advance();
  await expect(kit.work.retry("one")).rejects.toThrow("not abandoned");
});

it("dedupes the request after interruption between submit and saving its ID", async () => {
  const kit = await open({ wrap: (conversation) => ({
    commit: conversation.commit.bind(conversation),
    submit: async (...args) => {
      await conversation.submit(...args);
      throw new Error("interrupted after submit");
    },
  }) });
  kit.faux.setResponses([fauxAssistantMessage("Handled before interruption.")]);
  await kit.work.admit(event("crash"));
  await expect(kit.work.advance()).rejects.toThrow("interrupted after submit");
  await kit.conversation.waitForIdle(context);
  expect((await kit.work.read())["event:crash"].kind).toBe("admitted");
  const original = await kit.conversation.commit((tx) => tx.submissionByRequest(kit.conversation.id, "event:event:crash:0"), context);
  expect(original).toBeDefined();
  await kit.harness.close(context);
  const reopened = await open({ dir: kit.dir });
  await reopened.work.advance();
  await reopened.conversation.waitForIdle(context);
  await reopened.work.advance();
  expect((await reopened.work.read())["event:crash"]).toMatchObject({ kind: "done", submission: original!.id });
  expect(reopened.faux.state.callCount).toBe(0);
  expect(kit.faux.state.callCount).toBe(1);
  const records = await reopened.harness.inspect(context);
  expect(records.submissions).toEqual([]);
  const page = await reopened.conversation.entries({ order: "ascending" }, 100, undefined, context);
  expect(JSON.stringify(page.items).split("Marketplace event:")).toHaveLength(2);
});
