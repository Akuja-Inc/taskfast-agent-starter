import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect, it, vi } from "vitest";
import { openMarketplaceAgent, type MarketplaceAgent } from "../src/core/agent.js";
import { runAgents } from "../src/run.js";

const context = BACKGROUND_CONTEXT;
const post = { title: "Edit the portable guide", description: "Copy edit two lines", budget: "5.00", pickup_deadline_hours: 24 };
const event = { event_id: "portable-event", event: "task.updated", task_id: "11111111-1111-4111-8111-111111111111" };
const agentId = "33333333-3333-4333-8333-333333333333";
const tool = (o: { name: string; input: Record<string, unknown>; index: number }) => ({ index: o.index, id: `call-${o.index}`, type: "function", function: { name: o.name, arguments: JSON.stringify(o.input) } });
function bundleFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? bundleFiles(join(folder, entry.name)).map((name) => join(entry.name, name)) : [entry.name]).sort();
}
function eventCount(transcript: Awaited<ReturnType<MarketplaceAgent["conversation"]["context"]>>): number {
  return transcript.messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("portable-event")).length;
}

it("restores a stopped complete agent archive with private resources, event history and duplicate protection intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-archive-"));
  const source = join(root, "first-host", "agents", "1");
  const destination = join(root, "other-host", "agents", "1");
  const responses = [
    { tool_calls: [tool({ name: "remember", input: { note: "Keep the guide short." }, index: 0 }), tool({ name: "post_task", input: post, index: 1 })] },
    { content: "Posted once." },
    { tool_calls: [tool({ name: "wallet_balance", input: {}, index: 0 }), tool({ name: "remember", input: { note: "The event was handled." }, index: 1 })] },
    { content: "Event handled." },
    { tool_calls: [tool({ name: "post_task", input: post, index: 0 }), tool({ name: "wallet_balance", input: {}, index: 1 })] },
    { content: "The old post was not repeated." },
  ];
  const headers: string[] = [];
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    headers.push(request.headers.authorization ?? "");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const next = responses.shift();
    if (!next) { response.writeHead(500); response.end("unexpected model run"); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "local", choices: [{ index: 0, delta: { role: "assistant", ...next }, finish_reason: "tool_calls" in next ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  let owned: MarketplaceAgent | undefined;
  let running: Promise<void> | undefined;
  let stop = new AbortController();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing model address");
  async function start(folder: string) {
    stop = new AbortController();
    running = runAgents({ agentsDir: join(folder, ".."), env: "local", signal: stop.signal, log: () => {}, pingEveryMs: 60_000,
      openAgent: async (options) => {
        owned = await openMarketplaceAgent({ ...options, recoverEveryMs: 60_000, now: () => new Date("2026-06-20T12:00:00Z") });
        return owned;
      },
    });
    await expect.poll(() => owned, { timeout: 4000 }).toBeDefined();
    const agent = owned;
    if (!agent) throw new Error("agent did not open");
    return agent;
  }
  try {
    mkdirSync(join(source, ".taskfast"), { recursive: true, mode: 0o700 });
    writeFileSync(join(source, "agent.json"), JSON.stringify({ role: "poster", model: "ollama:portable-model", character: { name: "Editor", businessName: "Editing", businessDescription: "Careful copy editing", goals: "Post the guide once", budgetUsd: 5 }, dials: { competence: 0.9, diligence: 0.9, priceSensitivity: 0.5, temperament: "patient" }, limits: { perJobUsd: 4, dailyUsd: 4 } }));
    writeFileSync(join(source, ".env"), `OLLAMA_API_KEY=synthetic-model-key\nOLLAMA_BASE_URL=http://127.0.0.1:${address.port}/v1\n`, { mode: 0o600 });
    writeFileSync(join(source, ".taskfast", "config.json"), JSON.stringify({ api_key: "synthetic-marketplace-key", agent_id: agentId, keystore_path: ".taskfast/wallet.json" }), { mode: 0o600 });
    writeFileSync(join(source, ".taskfast", "wallet.json"), JSON.stringify({ encrypted: "synthetic ciphertext" }), { mode: 0o600 });
    writeFileSync(join(source, ".taskfast", "wallet-password"), "synthetic unlock\n", { mode: 0o400 });
    const cli = join(root, "taskfast");
    writeFileSync(cli, `#!${process.execPath}\n` + readFileSync(new URL("fixtures/portable-cli.mjs", import.meta.url), "utf8"));
    chmodSync(cli, 0o700);
    vi.stubEnv("TASKFAST_BIN", cli);
    vi.stubEnv("OLLAMA_API_KEY", "wrong-host-key");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:1/v1");
    const first = await start(source);
    await expect.poll(async () => Object.values((await first.status()).actions).map((action) => action.status), { timeout: 4000 }).toEqual(["done"]);
    await first.waitForIdle();
    await first.deliver(event);
    await first.recover();
    await first.waitForIdle();
    await first.recover();
    const before = await first.status();
    expect(before).toMatchObject({ identity: { env: "local", agentId }, memory: ["Keep the guide short.", "The event was handled."], spend: { "2026-06-20": 3 } });
    expect(eventCount(await first.conversation.context(context))).toBe(1);
    stop.abort();
    await running;
    owned = undefined;
    const inventory = bundleFiles(source);
    expect(inventory).toEqual(expect.arrayContaining(["agent.json", ".env", ".taskfast/config.json", ".taskfast/wallet.json", ".taskfast/wallet-password", ".pi-state/local/state.sqlite", ".pi-state/local/state.sqlite.owner"]));
    const archive = join(root, "synthetic-agent.zip");
    execFileSync("zip", ["-qr", archive, "1"], { cwd: join(source, "..") });
    // Quarantine the stopped original; never run both copies.
    renameSync(source, join(root, "stopped-original"));
    mkdirSync(join(destination, ".."), { recursive: true });
    execFileSync("unzip", ["-q", archive, "-d", join(destination, "..")]);
    expect(bundleFiles(destination)).toEqual(inventory);
    const restored = await start(destination);
    await expect.poll(() => headers.length, { timeout: 4000 }).toBe(6);
    await restored.waitForIdle();
    expect(await restored.status()).toEqual(before);
    expect(eventCount(await restored.conversation.context(context))).toBe(1);
    await restored.deliver(event);
    await restored.recover();
    await restored.waitForIdle();
    expect(headers).toEqual(Array(6).fill("Bearer synthetic-model-key"));
    expect(responses).toEqual([]);
    const commands = readFileSync(join(destination, ".taskfast", "commands.jsonl"), "utf8").trim().split("\n").map((line): unknown => JSON.parse(line));
    expect(commands.filter((value) => typeof value === "object" && value !== null && "command" in value && value.command === "post")).toHaveLength(1);
    for (const command of ["wallet", "version", "events"]) expect(commands).toContainEqual({ command, cwd: destination, names: ["HOME", "PATH", "TASKFAST_CONFIG"] });
    expect(JSON.stringify(requests)).toContain("already done");
    expect(existsSync(join(root, "stopped-original", ".pi-state", "local", "state.sqlite"))).toBe(true);
    expect(relative(source, destination)).not.toBe("");
  } finally {
    stop.abort();
    await running;
    await owned?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
