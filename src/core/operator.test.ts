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
async function open(dir = mkdtempSync(join(tmpdir(), "operator-"))) {
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
