import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { startConsole, type ConsoleAgent, type HostFacts } from "./console.js";
import { runCli } from "./core/cli.js";
import type { Command } from "./core/policy.js";
import { UUID } from "./core/tools.js";
import { openMarketplaceAgent, type MarketplaceAgent } from "./core/agent.js";
import { startListener } from "./core/listener.js";
import { parseAgentSpec } from "./core/spec.js";
import { parseWalletPasswordFile } from "./core/cli.js";
import { PASSWORD_PATH, folderFile, portableFile, providerSettings } from "./core/folder.js";
import type { AgentSpec, Env, Runtime } from "./core/types.js";

export const ENVIRONMENTS = { production: "prod", staging: "staging", development: "local" } as const satisfies Record<string, Env>;
export type Environment = keyof typeof ENVIRONMENTS;
export function taskfastEnv(name: string): Env {
  const environment = Object.entries(ENVIRONMENTS).find(([key]) => key === name);
  if (!environment) throw new Error(`--env must be production, staging or development, not ${JSON.stringify(name)}`);
  return environment[1];
}
// The console shows only agents whose handle carries its controls.
export type AgentHandle = Pick<MarketplaceAgent, "deliver" | "ping" | "close"> & Partial<ConsoleAgent["agent"]>;
export interface RunOptions {
  agentsDir: string;
  env: Env;
  walletPasswordFile?: string;
  // Serve the local console on 127.0.0.1 at this port (0 picks one). Off unless given.
  console?: { port: number };
  // The console's own server reads (wallet, tasks). Defaults to the agent's CLI.
  command?: Command;
  openAgent?(agent: { id: string; spec: AgentSpec; runtime: Runtime; storePath: string }): Promise<AgentHandle>;
  listen?: typeof startListener;
  signal: AbortSignal;
  log(line: string): void;
  pingEveryMs?: number;
}

const READ_TTL_MS = 60_000;
// The stream's sentinels arrive as listener log lines (pump.ts).
function streamStatus(line: string): HostFacts["stream"] | undefined {
  if (line === "sentinel connected" || line === "sentinel resumed") return "connected";
  if (line === "sentinel reconnecting") return "reconnecting";
  if (line === "sentinel auth_failed") return "auth failed";
  if (line.startsWith("stream exited")) return "restarting";
  return undefined;
}

// One owning process per store. Event listeners restart with backoff independently
// of model runs. The periodic poll survives each host restart and wakes idle agents.
export async function runAgents(o: RunOptions): Promise<void> {
  const walletPasswordFile = o.walletPasswordFile === undefined ? undefined : parseWalletPasswordFile(o.walletPasswordFile);
  const ids = existsSync(o.agentsDir) ? readdirSync(o.agentsDir).filter((id) => existsSync(join(o.agentsDir, id, "agent.json"))) : [];
  if (!ids.length) throw new Error(`no agents: put one in ${o.agentsDir}/<id>/agent.json (copy one from examples/)`);
  // Validate all files before opening any store or starting any marketplace work.
  const agents = ids.map((id) => {
    const agentDir = resolve(o.agentsDir, id);
    const specPath = folderFile({ agentDir, path: "agent.json", resource: "agent specification" });
    const spec = parseAgentSpec(JSON.parse(readFileSync(specPath, "utf8")));
    // Never silently create blank state where the prior default ledger is left.
    // Arbitrary external old state locations cannot be discovered: operators must
    // preserve them and must not restart their credentials with fresh state.
    const previous = [resolve(o.agentsDir, "..", ".pi-state", o.env, id, "state.sqlite"), resolve(".pi-state", o.env, id, "state.sqlite")];
    if (previous.some((path) => ["", ".owner", "-wal", "-shm"].some((suffix) => existsSync(path + suffix)))) throw new Error(`${id}: prior shared store exists; preserve it, do not start a blank ledger`);
    const configPath = folderFile({ agentDir, path: ".taskfast/config.json", resource: "TaskFast config" });
    if (!existsSync(configPath)) throw new Error(`${id}: no ${configPath}; run \`taskfast --env ${o.env} init\` in ${join(o.agentsDir, id)}`);
    const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${id}: TaskFast config must be an object`);
    if ("keystore_path" in config && config.keystore_path !== null) portableFile({ agentDir, path: config.keystore_path, resource: "wallet reference" });
    providerSettings(agentDir); // Check persisted file references before any store opens.
    const localPassword = folderFile({ agentDir, path: PASSWORD_PATH, resource: "wallet unlock file" });
    const file = existsSync(localPassword) ? localPassword : walletPasswordFile;
    return { id, spec, specPath, storePath: folderFile({ agentDir, path: `.pi-state/${o.env}/state.sqlite`, resource: "permanent state" }), runtime: { env: o.env, configPath, ...(file === undefined ? {} : { walletPasswordFile: file }) } };
  });
  type Item = typeof agents[number];
  const running: { id: string; spec: AgentSpec; agent: AgentHandle; listener?: ReturnType<typeof startListener> }[] = [];
  let consoleServer: Awaited<ReturnType<typeof startConsole>> | undefined;
  const streams = new Map<string, HostFacts["stream"]>();
  // Opens one agent's store, then its stream, keeping its place among the others.
  async function start(item: Item, at = running.length): Promise<void> {
    const agent = o.openAgent
      ? await o.openAgent(item)
      : await openMarketplaceAgent({ spec: item.spec, runtime: item.runtime, storePath: item.storePath, log: (line) => o.log(`${item.id}: ${line}`) });
    const owned: typeof running[number] = { id: item.id, spec: item.spec, agent };
    running.splice(at, 0, owned);
    streams.set(item.id, "starting");
    owned.listener = (o.listen ?? startListener)({ runtime: item.runtime, deliver: (event) => agent.deliver(event), log: (line) => {
      const stream = streamStatus(line);
      if (stream) streams.set(item.id, stream);
      o.log(`${item.id}: ${line}`);
    } });
  }
  // Server reads for the console, each kept for a minute so page refreshes cost nothing.
  const reads = new Map<string, { at: number; value: unknown }>();
  async function read(item: Item, args: string[]): Promise<unknown> {
    const key = `${item.id} ${args.join(" ")}`;
    const cached = reads.get(key);
    if (cached && Date.now() - cached.at < READ_TTL_MS) return cached.value;
    const result = await (o.command ?? runCli)(item.runtime, args);
    const value = result.outcome === "ok" ? result.data ?? null : { error: result.error ?? result.outcome };
    reads.set(key, { at: Date.now(), value });
    return value;
  }
  async function facts(item: Item, taskIds: string[]): Promise<HostFacts> {
    const deadLetterPath = join(dirname(item.runtime.configPath), "dead-letter.jsonl");
    const deadLetters = existsSync(deadLetterPath)
      ? readFileSync(deadLetterPath, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as HostFacts["deadLetters"][number]]; } catch { return []; } })
      : [];
    return {
      unlockFile: item.runtime.walletPasswordFile !== undefined && existsSync(item.runtime.walletPasswordFile),
      stream: streams.get(item.id) ?? "starting",
      wallet: await read(item, ["wallet", "balance"]),
      tasks: Object.fromEntries(await Promise.all(taskIds.filter((id) => UUID.test(id)).map(async (id) => [id, await read(item, ["task", "get", "--", id])]))),
      deadLetters,
    };
  }
  // Saves a checked agent file, then reopens only that agent. If it cannot reopen it
  // stays stopped and the others keep running.
  async function reopen(item: Item, spec: AgentSpec): Promise<void> {
    const temporary = `${item.specPath}.saving`;
    writeFileSync(temporary, `${JSON.stringify(spec, null, 2)}\n`);
    renameSync(temporary, item.specPath);
    item.spec = spec;
    const at = running.findIndex((owned) => owned.id === item.id);
    if (at >= 0) {
      const [owned] = running.splice(at, 1);
      // Stream before store, as at shutdown.
      await owned.listener?.close();
      await owned.agent.close();
    }
    try { await start(item, at >= 0 ? at : running.length); }
    catch (error) {
      o.log(`${item.id}: stopped, could not reopen: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  try {
    for (const item of agents) await start(item);
    if (o.console) {
      consoleServer = await startConsole({
        port: o.console.port, token: randomBytes(32).toString("hex"), env: o.env,
        agents: () => running.flatMap(({ id, spec, agent }) => {
          const item = agents.find((candidate) => candidate.id === id);
          if (!item || !agent.operator || !agent.status || !agent.transcript) return [];
          return [{ id, spec, agent: { operator: agent.operator, status: agent.status, transcript: agent.transcript }, saveSpec: (next: AgentSpec) => reopen(item, next), host: (taskIds: string[]) => facts(item, taskIds) }];
        }),
      });
      o.log(`console: ${consoleServer.url}`);
    }
    o.log(`running ${ids.length} agent(s) on ${o.env}: ${ids.join(", ")}`);
    while (!o.signal.aborted) {
      await Promise.all(running.map(({ id, agent }) => agent.ping().catch((error: unknown) => o.log(`${id}: ping failed: ${error instanceof Error ? error.message : String(error)}`))));
      await sleep(o.pingEveryMs ?? 900_000, undefined, { signal: o.signal }).catch(() => {});
    }
  } finally {
    await consoleServer?.close();
    // Close streams before stores so no event can be ACKed after its owner closed.
    await Promise.allSettled(running.map(async ({ listener }) => listener?.close()));
    await Promise.all(running.map(({ agent }) => agent.close()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { env: { type: "string", default: "production" }, "wallet-password-file": { type: "string" }, console: { type: "boolean", default: false }, "console-port": { type: "string", default: "7070" } } });
  const file = values["wallet-password-file"];
  if (file !== undefined && !file) throw new Error("--wallet-password-file needs a path");
  const port = Number(values["console-port"]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--console-port must be a port number");
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  await runAgents({ agentsDir: "agents", env: taskfastEnv(values.env), ...(file === undefined ? {} : { walletPasswordFile: resolve(file) }), ...(values.console ? { console: { port } } : {}), signal: stop.signal, log: (line) => process.stdout.write(`${line}\n`) });
}
