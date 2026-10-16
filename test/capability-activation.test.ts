import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import { CapabilityManager } from "../src/capabilities.js";
import { openMarketplaceAgent, type MarketplaceAgent } from "../src/core/agent.js";
import { parseAgentSpec } from "../src/core/spec.js";
import { example } from "./example.js";

it("publishes a staged skill through a real idle store reopen without losing a completed action or Pause", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capability-activation-"));
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "test" }] }); models.setProvider(faux.provider);
  let dispatches = 0;
  const options = {
    spec: { ...parseAgentSpec(example("brisk-poster")), model: "faux:test" }, models,
    storePath: join(dir, "state.sqlite"), runtime: { env: "staging" as const, configPath: join(dir, "config.json") },
    command: async (_runtime: unknown, args: string[]) => {
      if (args[0] === "me") return { outcome: "ok" as const, data: { profile: { id: "33333333-3333-4333-8333-333333333333" } } };
      dispatches++; return { outcome: "ok" as const };
    },
  };
  let agent: MarketplaceAgent | undefined;
  const manager = new CapabilityManager({
    agentDir: dir, env: "staging", active: false,
    activate: async ({ publish, signal, afterCommit }) => {
      if (!agent) throw new Error("No active agent");
      const release = await agent.quiesce(signal);
      try {
        await publish();
        await agent.close();
        agent = await openMarketplaceAgent({ ...options, startHeld: true });
        const replacement = agent;
        afterCommit(async () => { await manager.markActive(); await replacement.releaseInitialHold(); }, async () => { await replacement.close(); manager.markStopped(); });
      } finally { await release(); }
    },
  });
  try {
    agent = await openMarketplaceAgent(options);
    await manager.markActive();
    faux.setResponses([fauxAssistantMessage([fauxToolCall("task_claim", { task_id: "11111111-1111-4111-8111-111111111111" })], { stopReason: "toolUse" }), fauxAssistantMessage("Claimed.")]);
    await agent.ping(); await agent.waitForIdle();
    await agent.operator.setPaused(true);
    const before = await agent.status();
    expect(dispatches).toBe(1);
    const initial = await manager.view();
    const staged = await manager.command("stage-skill", { revision: initial.revision, files: [{ path: "research/SKILL.md", text: "---\nname: research\ndescription: Review task references\n---\nRead carefully.\n" }], enabled: true, replace: false });
    await manager.command("apply", { revision: staged.revision, requestId: "activate-real-store" });
    await vi.waitFor(async () => expect((await manager.view()).apply.state).toBe("succeeded"));
    expect(existsSync(join(dir, ".agents/skills/research/SKILL.md"))).toBe(true);
    expect((await manager.view()).activeSkills.map(({ name }) => name)).toEqual(["research"]);
    expect(await agent.status()).toEqual(before);
    expect((await agent.operator.state()).paused).toBe(true);
    expect(dispatches).toBe(1);
  } finally { await manager.close(); await agent?.close(); rmSync(dir, { recursive: true, force: true }); }
});
