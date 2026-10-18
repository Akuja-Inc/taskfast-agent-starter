import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it } from "vitest";
import { openMarketplaceAgent, type MarketplaceAgent } from "../src/core/agent.js";
import type { CliResult } from "../src/core/cli.js";
import { marketplacePrompt } from "../src/core/prompt.js";
import { parseAgentSpec } from "../src/core/spec.js";
import { example } from "./example.js";

const dirs: string[] = [];
const opened: MarketplaceAgent[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((agent) => agent.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

it("numbers notes from 1 in the prompt", () => {
  const prompt = marketplacePrompt(parseAgentSpec(example("brisk-poster")), ["First", "Second"], []);
  expect(prompt).toContain("Your notes:\n1: First\n2: Second");
});

// gh#122: the console shows notes from 1, so forget takes the number the prompt shows.
it("forget drops the note numbered 1, refuses 0, and the change survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notes-"));
  dirs.push(dir);
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const prompts: string[] = [];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("remember", { note: "First" }), fauxToolCall("remember", { note: "Second" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Noted."),
    (context) => { prompts.push(JSON.stringify(context)); return fauxAssistantMessage([fauxToolCall("forget", { index: 0 }), fauxToolCall("forget", { index: 1 })], { stopReason: "toolUse" }); },
    fauxAssistantMessage("Forgot."),
  ]);
  const options = {
    storePath: join(dir, "state.sqlite"), spec: { ...parseAgentSpec(example("brisk-poster")), model: "faux:test" }, runtime: { env: "staging" as const, configPath: join(dir, "config.json") }, models,
    command: async (_rt: unknown, args: string[]): Promise<CliResult> => args[0] === "me" ? { outcome: "ok", data: { profile: { id: "33333333-3333-4333-8333-333333333333" } } } : { outcome: "ok" },
  };
  const agent = await openMarketplaceAgent(options);
  opened.push(agent);
  await agent.ping(); await agent.waitForIdle();
  expect((await agent.status()).memory).toEqual(["First", "Second"]);
  await agent.ping(); await agent.waitForIdle();
  expect(prompts[0]).toContain("1: First\\n2: Second");
  expect((await agent.status()).memory).toEqual(["Second"]);
  expect(JSON.stringify(await agent.conversation.context(BACKGROUND_CONTEXT))).toContain("index must be a note number from 1");
  await opened.pop()!.close();
  const reopened = await openMarketplaceAgent(options);
  opened.push(reopened);
  expect((await reopened.status()).memory).toEqual(["Second"]);
});
