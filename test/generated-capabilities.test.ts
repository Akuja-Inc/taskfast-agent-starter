import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { openMarketplaceAgent, type MarketplaceAgent } from "../src/core/agent.js";
import type { CliResult } from "../src/core/cli.js";
import { loadMcpConfig } from "../src/core/mcp-config.js";
import { loadSkills } from "../src/core/skills.js";
import { parseAgentFile, parseAgentSpec } from "../src/core/spec.js";
import { openAgentStorage } from "../src/core/storage.js";
import { setup, type SetupIO } from "../src/setup.js";
import { approve, FIXTURE, httpFixture, writeMcp } from "./mcp-fixture.js";

const ROOT = join(import.meta.dirname, "..");
const BUNDLE = join(ROOT, "test/fixtures/cli/skills/taskfast-agent");
const context = BACKGROUND_CONTEXT;
const post = { title: "Edit the guide", description: "Copy edit two lines.", budget: "5.00", pickup_deadline_hours: 24 };
const event = { event_id: "generated-event", event: "task.updated", task_id: "11111111-1111-4111-8111-111111111111" };
const toolTurn = (name: string, input: Parameters<typeof fauxToolCall>[1], id: string) => fauxAssistantMessage([fauxToolCall(name, input, { id })], { stopReason: "toolUse" });
const transcript = async (agent: MarketplaceAgent) => JSON.stringify(await agent.transcript(400));

it.each(["stdio", "http"])("runs a generated agent's capabilities through compaction, move and recovery (%s)", async (transport) => {
  const root = mkdtempSync(join(tmpdir(), "generated-capabilities-"));
  const http = transport === "http" ? await httpFixture() : undefined;
  const opened: MarketplaceAgent[] = [];
  const commands: string[][] = [];
  const logs: string[] = [];
  try {
    cpSync(join(ROOT, "examples"), join(root, "examples"), { recursive: true });
    cpSync(join(ROOT, "providers.json"), join(root, "providers.json"));
    const io: SetupIO = {
      root, env: {},
      ask: async () => { throw new Error("fully flagged setup must not prompt"); },
      run: () => { throw new Error("setup must not initialize an account or install software"); },
      // Offline stand-in for the CLI export, using its unchanged, captured bundle.
      capture: (cmd, args, cwd) => {
        expect(cmd).toBe("taskfast");
        if (args[0] === "--version") return { status: 0, stdout: "taskfast 0.20.1\n" };
        expect(args).toEqual(["--env", "staging", `--config=${cwd}/absent.json`, "--no-trace", "skills", "--yes"]);
        for (const folder of [".agents", ".claude"]) cpSync(BUNDLE, join(cwd, folder, "skills/taskfast-agent"), { recursive: true });
        return { status: 0, stdout: "" };
      },
      log: (line) => { logs.push(line); },
    };
    await setup(io, { env: "staging", provider: "ollama", model: "fixture", agent: "editor", role: "both", name: "Editor", business: "Editing", description: "Careful copy editing.", goals: "Finish small jobs honestly", budget: "5", init: false, taskfastSkill: true });
    let folder = join(root, "agents/editor");
    const skillFiles = [...loadSkills(folder)[0]!.files.keys()];
    expect(skillFiles).toContain("reference/WORKER.md");
    const provenance = readFileSync(join(folder, ".agents/provenance.json"), "utf8");
    expect(skillFiles).toHaveLength(7);
    const hashes = Object.fromEntries(skillFiles.map((file) => [file, createHash("sha256").update(readFileSync(join(folder, ".agents/skills/taskfast-agent", file))).digest("hex")]));
    expect(JSON.parse(provenance)).toMatchObject({ "taskfast-agent": { source: "taskfast-cli", version: "0.20.1", files: hashes } });
    expect(existsSync(join(folder, ".claude"))).toBe(false);
    // Only synthetic MCP credentials. No account, wallet or model-provider service is used.
    const secret = "synthetic-generated-docs-token";
    if (http) {
      writeMcp(folder, { docs: { url: http.url, headers: { Authorization: "DOCS_SECRET" }, tools: { search: approve("search") } } }, { DOCS_SECRET: secret });
    } else {
      mkdirSync(join(folder, "fixture"));
      cpSync(FIXTURE, join(folder, "fixture/server.mjs"));
      writeMcp(folder, { docs: { command: process.execPath, args: ["server.mjs"], cwd: "fixture", env: { DOCS_TOKEN: "DOCS_SECRET" }, tools: { search: approve("search") } } }, { DOCS_SECRET: secret });
    }
    const config = readFileSync(join(folder, "mcp.json"), "utf8");
    const command = async (_runtime: unknown, args: string[]): Promise<CliResult> => {
      commands.push(args);
      if (args[0] === "me") return { outcome: "ok", data: { profile: { id: "33333333-3333-4333-8333-333333333333" } } };
      if (args[0] === "platform") return { outcome: "ok", data: { config: { submission_fee: "3.00" } } };
      if (args[0] === "post") return { outcome: "uncertain", error: "connection lost after dispatch" };
      throw new Error(`unexpected marketplace command: ${args.join(" ")}`);
    };
    async function open() {
      const faux = fauxProvider({ models: [{ id: "test", contextWindow: 128000 }] });
      const models = createModels(); models.setProvider(faux.provider);
      const file: unknown = JSON.parse(readFileSync(join(folder, "agent.json"), "utf8"));
      const generated = parseAgentSpec({ ...parseAgentFile(file), instructions: readFileSync(join(folder, "INSTRUCTIONS.md"), "utf8") });
      const agent = await openMarketplaceAgent({
        storePath: join(folder, ".pi-state/staging/state.sqlite"),
        spec: { ...generated, model: "faux:test" }, models, command,
        runtime: { env: "staging", configPath: join(folder, ".taskfast/config.json") },
        now: () => new Date("2026-06-20T12:00:00Z"), recoverEveryMs: 60_000,
        log: (line) => { logs.push(line); },
      });
      opened.push(agent);
      return { agent, faux };
    }
    const first = await open();
    first.faux.setResponses([
      toolTurn("skill_read", { skill: "taskfast-agent" }, "skill"),
      toolTurn("skill_read", { skill: "taskfast-agent", file: "reference/WORKER.md" }, "role"),
      toolTurn("me", {}, "me"),
      toolTurn("mcp_docs_search", { query: "portable editing" }, "read"),
      toolTurn("skill_read", { skill: "taskfast-agent", file: "../../../.mcp.env" }, "escape"),
      toolTurn("mcp_docs_delete", { id: "guide" }, "unapproved"),
      toolTurn("remember", { note: "Investigate the uncertain post; never repeat it." }, "note"),
      toolTurn("post_task", post, "post"),
      fauxAssistantMessage("The post outcome is uncertain."),
    ]);
    await first.agent.ping(); await first.agent.waitForIdle();
    const before = await first.agent.status();
    expect(before).toMatchObject({ spend: { "2026-06-20": 3 }, memory: ["Investigate the uncertain post; never repeat it."] });
    expect(Object.values(before.actions).map((action) => action.status)).toEqual(["uncertain"]);
    const history = await transcript(first.agent);
    for (const text of ["TaskFast Agent", "# Worker Loop", "results for portable editing", "has no file ../../../.mcp.env", "not available"]) expect(history).toContain(text);
    expect(history).not.toContain(secret);
    expect(commands.filter((args) => args[0] === "me")).toHaveLength(2);
    expect(first.agent.capabilityConnections()).toEqual([{ name: "docs", state: "connected" }]);
    await expect(openAgentStorage(join(folder, ".pi-state/staging/state.sqlite"))).rejects.toThrow("already owned");

    await first.agent.operator.setPaused(true);
    await first.agent.operator.setFrozen(true);
    for (let index = 0; index < 8; index++) await first.agent.conversation.submit({ type: "write", entry: { kind: "app.context", model: [{ role: "user", content: "Editing background. ".repeat(5000), timestamp: index }] } }, context);
    first.faux.setResponses([fauxAssistantMessage("The post is uncertain. Read the ledger and reload the installed skill when needed.")]);
    await first.agent.conversation.compact(undefined, context);
    await first.agent.waitForIdle();
    expect((await first.agent.conversation.context(context)).head?.kind).toBe("pi.compaction");
    await first.agent.deliver(event); // Admission while paused must survive relocation.
    await first.agent.close();
    const moved = join(root, "relocated-editor");
    renameSync(folder, moved); folder = moved; // Move, never copy or delete a live ledger.
    expect(readFileSync(join(folder, ".agents/provenance.json"), "utf8")).toBe(provenance);
    expect(readFileSync(join(folder, "mcp.json"), "utf8")).toBe(config);
    expect(loadMcpConfig(folder)[0]?.credentials).toEqual(http ? { Authorization: secret } : { DOCS_TOKEN: secret });
    const second = await open();
    expect(await second.agent.status()).toEqual(before);
    expect(await second.agent.operator.state()).toMatchObject({ paused: true, frozen: true });
    expect(second.faux.state.callCount).toBe(0);
    let resumedPrompt = "";
    second.faux.setResponses([
      (input) => { resumedPrompt = JSON.stringify(input); return toolTurn("skill_read", { skill: "taskfast-agent", file: "reference/WORKER.md" }, "reload"); },
      toolTurn("mcp_docs_search", { query: "after relocation" }, "moved-read"),
      toolTurn("post_task", post, "retry"),
      fauxAssistantMessage("Recovered without repeating the uncertain post."),
    ]);
    // Unfreeze so the ledger, not the spending freeze, must block the duplicate.
    await second.agent.operator.setFrozen(false);
    await second.agent.operator.setPaused(false);
    await second.agent.recover(); await second.agent.waitForIdle();
    expect(commands.filter((args) => args[0] === "post")).toHaveLength(1);
    expect(await second.agent.status()).toEqual(before);
    expect(resumedPrompt).toContain("- taskfast-agent:");
    expect(resumedPrompt).toContain("mcp_docs_search");
    expect(resumedPrompt).not.toContain(secret);
    const recovered = await transcript(second.agent);
    for (const text of ["# Worker Loop", "results for after relocation", "uncertain"]) expect(recovered).toContain(text);
    expect(recovered).not.toContain(secret);
    const count = second.faux.state.callCount;
    expect(count).toBe(4);
    await second.agent.deliver(event); await second.agent.recover(); await second.agent.waitForIdle();
    expect(second.faux.state.callCount).toBe(count);
    expect((await second.agent.operator.events())["event:generated-event"]).toMatchObject({ kind: "done" });
    expect(logs.join("\n")).not.toContain(secret);
    if (http) {
      expect(http.headers.length).toBeGreaterThan(0);
      expect(http.headers.every((headers) => headers.authorization === secret)).toBe(true);
    }
  } finally {
    await Promise.all(opened.map((agent) => agent.close()));
    await http?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
