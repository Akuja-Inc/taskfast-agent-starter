import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it } from "vitest";
import { openMarketplaceAgent, type MarketplaceAgent } from "../src/core/agent.js";
import type { CliResult } from "../src/core/cli.js";
import { parseAgentSpec } from "../src/core/spec.js";
import { openAgentStorage } from "../src/core/storage.js";
import type { AgentSpec } from "../src/core/types.js";
import { example } from "./example.js";

// The fixture beside this suite is a real 1.1.0 store killed mid-write; see its
// README. Reopening it under the pinned version is the upgrade's real contract.
const context = BACKGROUND_CONTEXT;
const dirs: string[] = [];
const opened: MarketplaceAgent[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((agent) => agent.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const agentId = "33333333-3333-4333-8333-333333333333";
const first = { title: "Edit the guide", description: "Copy edit the short guide.", budget: "10.00", pickup_deadline_hours: 24 };
const second = { ...first, title: "Edit another guide" };
function spec(): AgentSpec {
  const value: unknown = example("brisk-poster");
  return { ...parseAgentSpec(value), model: "faux:test", limits: { dailyUsd: 10, perJobUsd: 4 } };
}

it("reopens the 1.1.0 store: migrates the interrupted write, keeps the policy and never re-dispatches it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-boundary-"));
  dirs.push(dir);
  const storePath = join(dir, "state.sqlite");
  copyFileSync(new URL("./fixtures/pi-1.1.0-store/state.sqlite", import.meta.url), storePath);
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("The interrupted post is not repeated.")]);
  const calls: string[][] = [];
  const agent = await openMarketplaceAgent({
    storePath, spec: spec(), runtime: { env: "staging", configPath: join(dir, "config.json") }, models,
    command: async (_rt, args): Promise<CliResult> => { calls.push(args); return args[0] === "me" ? { outcome: "ok", data: { profile: { id: agentId } } } : { outcome: "ok" }; },
  });
  opened.push(agent);
  await agent.waitForIdle();
  // Opening migrated the live version 1 tool task to the version 2 tagged union and
  // settled it; the already-complete version 1 tasks need no migration.
  const tools = await agent.conversation.commit((tx) => tx.scanTasks({ conversationId: agent.conversation.id, kind: "pi.tool" }, 10), context);
  expect(tools.items.map((task) => task.state.status)).toEqual(tools.items.map(() => "terminal"));
  const [migrated] = tools.items.filter((task) => task.version === 2);
  if (!migrated) throw new Error("no pi.tool task was migrated to version 2");
  expect((migrated.input as { kind: string }).kind).toBe("model");
  // The interrupted reservation became uncertain; nothing re-dispatched, spend and notes survived.
  const settled = await agent.status();
  expect(settled.identity).toEqual({ env: "staging", agentId });
  expect(settled.memory).toEqual(["Keep the guide concise."]);
  expect(Object.values(settled.actions).map((action) => action.status).sort()).toEqual(["done", "uncertain"]);
  expect(Object.values(settled.spend)).toEqual([6]);
  expect(calls).toEqual([["me"]]);
  // A second owner of the same store is still refused under the new pin.
  await expect(openAgentStorage(storePath)).rejects.toThrow(/already owned/);
  // Even an explicit repeat of both writes changes nothing: one is done, one uncertain.
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("post_task", first), fauxToolCall("post_task", second)], { stopReason: "toolUse" }),
    fauxAssistantMessage("Neither post repeats"),
  ]);
  await agent.ping();
  await agent.waitForIdle();
  expect(calls.filter((args) => args[0] === "post")).toEqual([]);
  const after = await agent.status();
  expect(Object.values(after.actions).map((action) => action.status).sort()).toEqual(["done", "uncertain"]);
  expect(Object.values(after.spend)).toEqual([6]);
  const transcript = JSON.stringify(await agent.conversation.context(context));
  expect(transcript).toContain("already done");
  expect(transcript).toContain("outcome unknown");
});
