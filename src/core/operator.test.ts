import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it } from "vitest";
import { openMarketplaceAgent, type MarketplaceAgent } from "./agent.js";
import type { CliResult } from "./cli.js";
import { parseAgentSpec } from "./spec.js";
import type { AgentSpec } from "./types.js";

const context = BACKGROUND_CONTEXT;
const dirs: string[] = [];
const opened: MarketplaceAgent[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((agent) => agent.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const agentId = "33333333-3333-4333-8333-333333333333";
const post = { title: "Edit the guide", description: "Copy edit the short guide.", budget: "10.00", pickup_deadline_hours: 24 };
function spec(): AgentSpec {
  const value: unknown = JSON.parse(readFileSync(new URL("../../examples/brisk-poster.json", import.meta.url), "utf8"));
  return { ...parseAgentSpec(value), model: "faux:test", limits: { dailyUsd: 50, perJobUsd: 20 } };
}
// A real store in a fresh folder, a scripted model and a recording CLI.
async function open(dir = mkdtempSync(join(tmpdir(), "operator-")), dispatch?: (args: string[]) => Promise<CliResult>) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const calls: string[][] = [];
  const agent = await openMarketplaceAgent({
    storePath: join(dir, "state.sqlite"), spec: spec(), runtime: { env: "staging", configPath: join(dir, "config.json") }, models,
    command: async (_rt, args): Promise<CliResult> => {
      calls.push(args);
      if (args[0] === "me") return { outcome: "ok", data: { profile: { id: agentId } } };
      if (args[0] === "platform") return { outcome: "ok", data: { config: { submission_fee: "3.00" } } };
      if (dispatch) return dispatch(args);
      return { outcome: "ok", data: { accepted: true } };
    },
  });
  opened.push(agent);
  return { agent, calls, faux, dir };
}
async function run(agent: MarketplaceAgent) { await agent.ping(); await agent.waitForIdle(); }

it("keeps the operator's controls across closing and reopening the store", async () => {
  const first = await open();
  await first.agent.operator.setFrozen(true);
  await first.agent.close();
  const reopened = await open(first.dir);
  expect(await reopened.agent.operator.state()).toMatchObject({ frozen: true });
});

it("admits events while paused without running the model, then runs them on resume", async () => {
  const kit = await open();
  await kit.agent.operator.setPaused(true);
  await kit.agent.deliver({ event_id: "e1", event: "message_received" });
  await kit.agent.ping();
  await kit.agent.recover();
  expect(kit.faux.state.callCount).toBe(0);
  expect(await kit.agent.operator.state()).toMatchObject({ paused: true });
  kit.faux.setResponses([fauxAssistantMessage("Answered the message.")]);
  await kit.agent.operator.setPaused(false);
  await kit.agent.waitForIdle();
  expect(kit.faux.state.callCount).toBe(1);
  const transcript = JSON.stringify((await kit.agent.conversation.context(context)).messages);
  expect(transcript).toContain("Marketplace event:");
  expect(transcript).not.toContain("Check your marketplace work");
});

it("delivers an operator message once, however often the same request is sent", async () => {
  const kit = await open();
  kit.faux.setResponses([fauxAssistantMessage("Will do."), fauxAssistantMessage("Extra run that must not happen.")]);
  await kit.agent.operator.message({ requestId: "r1", text: "Post one copy-editing job under $15." });
  await kit.agent.operator.message({ requestId: "r1", text: "Post one copy-editing job under $15." });
  await kit.agent.waitForIdle();
  const transcript = JSON.stringify((await kit.agent.conversation.context(context)).messages);
  expect(transcript.split("Message from your operator").length - 1).toBe(1);
  expect(transcript).toContain("Post one copy-editing job under $15.");
  expect(kit.faux.state.callCount).toBe(1);
});

it("holds operator messages while paused and delivers them on resume", async () => {
  const kit = await open();
  await kit.agent.operator.setPaused(true);
  await kit.agent.operator.message({ requestId: "r2", text: "The wallet is funded now." });
  await kit.agent.recover();
  expect(kit.faux.state.callCount).toBe(0);
  kit.faux.setResponses([fauxAssistantMessage("Thanks.")]);
  await kit.agent.operator.setPaused(false);
  await kit.agent.waitForIdle();
  expect(JSON.stringify((await kit.agent.conversation.context(context)).messages)).toContain("The wallet is funded now.");
});

it("puts standing orders in every system prompt, where the agent's own forget cannot reach them", async () => {
  const kit = await open();
  await kit.agent.operator.addOrder("Keep every job under $15 this week.");
  await kit.agent.operator.addOrder("Prefer workers with at least one review.");
  await kit.agent.operator.removeOrder(1);
  const prompts: string[] = [];
  kit.faux.setResponses([
    (ctx) => (prompts.push(JSON.stringify(ctx.messages)), fauxAssistantMessage([fauxToolCall("forget", { index: 0 })], { stopReason: "toolUse" })),
    (ctx) => (prompts.push(JSON.stringify(ctx.messages)), fauxAssistantMessage("Noted.")),
  ]);
  await run(kit.agent);
  expect(prompts).toHaveLength(2);
  for (const prompt of prompts) {
    expect(prompt).toContain("Keep every job under $15 this week.");
    expect(prompt).not.toContain("Prefer workers with at least one review.");
  }
  expect((await kit.agent.operator.state()).orders).toEqual(["Keep every job under $15 this week."]);
});

it("marks an uncertain action checked without letting it run again", async () => {
  const kit = await open(undefined, async () => { throw new Error("timed out"); });
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post)], { stopReason: "toolUse" }), fauxAssistantMessage("Unsure.")]);
  await run(kit.agent);
  const [key] = Object.keys((await kit.agent.status()).actions);
  expect((await kit.agent.status()).actions[key].status).toBe("uncertain");
  await kit.agent.operator.markChecked(key);
  expect(Object.keys((await kit.agent.operator.state()).checked)).toEqual([key]);
  expect((await kit.agent.status()).actions[key].status).toBe("uncertain");
  kit.faux.setResponses([fauxAssistantMessage([fauxToolCall("post_task", post, { id: "again" })], { stopReason: "toolUse" }), fauxAssistantMessage("Skipped.")]);
  await run(kit.agent);
  expect(kit.calls.filter((args) => args[0] === "post")).toHaveLength(1);
});

it("refuses a money tool while spending is frozen, before reserving anything, and still runs reads", async () => {
  const kit = await open();
  await kit.agent.operator.setFrozen(true);
  kit.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("wallet_balance", {}), fauxToolCall("post_task", post)], { stopReason: "toolUse" }),
    fauxAssistantMessage("Frozen, so I did not post."),
  ]);
  await run(kit.agent);
  const state = await kit.agent.status();
  expect(state.actions).toEqual({});
  expect(state.spend).toEqual({});
  expect(kit.calls.filter((args) => args[0] === "post")).toEqual([]);
  expect(kit.calls).toContainEqual(["wallet", "balance"]);
  expect(JSON.stringify((await kit.agent.conversation.context(context)).messages)).toContain("spending is frozen");
});
