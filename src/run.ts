import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
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
import { createAgentModels } from "./core/model.js";
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

// One durable replace: fsync the temporary file, rename it over the target,
// then fsync the directory so the rename itself survives a power loss.
function writeFileDurable(path: string, text: string): void {
  const temporary = `${path}.saving`;
  const file = openSync(temporary, "w");
  try {
    writeSync(file, text);
    fsyncSync(file);
  } finally { closeSync(file); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); }
  finally { closeSync(directory); }
}

// A dead-letter line is trusted only as a record with the three string fields
// the console reads; anything else parseable (null, arrays) is skipped.
function deadLetter(line: string): HostFacts["deadLetters"][number] | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== "string" || typeof record.reason !== "string" || typeof record.line !== "string") return undefined;
  return { at: record.at, reason: record.reason, line: record.line };
}

// One owning process per store. Event listeners restart with backoff independently
// of model runs. The periodic poll survives each host restart and wakes idle agents.
export async function runAgents(o: RunOptions): Promise<void> {
  const walletPasswordFile = o.walletPasswordFile === undefined ? undefined : parseWalletPasswordFile(o.walletPasswordFile);
  // The folder's own unlock file wins when present, otherwise the host-level one.
  // Discovery re-runs at each use: the console page invites creating the file
  // while the host is already running.
  function findUnlockFile(agentDir: string): string | undefined {
    const local = folderFile({ agentDir, path: PASSWORD_PATH, resource: "wallet unlock file" });
    return existsSync(local) ? local : walletPasswordFile;
  }
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
    const file = findUnlockFile(agentDir);
    return { id, agentDir, spec, specPath, storePath: folderFile({ agentDir, path: `.pi-state/${o.env}/state.sqlite`, resource: "permanent state" }), runtime: { env: o.env, configPath, ...(file === undefined ? {} : { walletPasswordFile: file }) } };
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
    // Shutdown beat this open: close the store and never join the roster.
    if (o.signal.aborted) {
      await agent.close();
      throw new Error("the host is shutting down");
    }
    running.splice(at, 0, owned);
    streams.set(item.id, "starting");
    try {
      owned.listener = (o.listen ?? startListener)({ runtime: item.runtime, deliver: (event) => agent.deliver(event), log: (line) => {
        const stream = streamStatus(line);
        if (stream) streams.set(item.id, stream);
        o.log(`${item.id}: ${line}`);
      } });
    } catch (error) {
      // An old CLI throws before the stream exists; leave no half-started agent behind.
      const index = running.indexOf(owned);
      if (index >= 0) running.splice(index, 1);
      streams.delete(item.id);
      await agent.close();
      throw error;
    }
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
  // Streams re-read dead letters per window, so cache the file per path on mtime/size.
  const deadLetterCache = new Map<string, { stat: { mtimeMs: number; size: number }; lines: HostFacts["deadLetters"] }>();
  function readDeadLetters(path: string): HostFacts["deadLetters"] {
    let stat: { mtimeMs: number; size: number };
    try { stat = statSync(path); } catch { return []; }
    const cached = deadLetterCache.get(path);
    if (cached && cached.stat.mtimeMs === stat.mtimeMs && cached.stat.size === stat.size) return cached.lines;
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => deadLetter(line) ?? []);
    deadLetterCache.set(path, { stat: { mtimeMs: stat.mtimeMs, size: stat.size }, lines });
    return lines;
  }
  async function facts(item: Item, taskIds: string[]): Promise<HostFacts> {
    const deadLetters = readDeadLetters(join(dirname(item.runtime.configPath), "dead-letter.jsonl"));
    const unlock = findUnlockFile(item.agentDir);
    return {
      unlockFile: unlock !== undefined && existsSync(unlock),
      stream: streams.get(item.id) ?? "starting",
      wallet: await read(item, ["wallet", "balance"]),
      tasks: Object.fromEntries(await Promise.all(taskIds.filter((id) => UUID.test(id)).map(async (id) => [id, await read(item, ["task", "get", "--", id])]))),
      deadLetters,
    };
  }
  // Saves a checked agent file, then reopens only that agent. If it cannot reopen it
  // stays stopped and the others keep running.
  async function reopen(item: Item, spec: AgentSpec): Promise<void> {
    if (o.signal.aborted) throw new Error("the host is shutting down; agent file not saved");
    // The console checks only the file's shape. Refuse what cannot be built before
    // anything changes: an unknown provider passes the shape check, fails to open
    // and the saved file would stop the next host start for every agent.
    try {
      await createAgentModels(spec.model, { agentDir: item.agentDir, settings: providerSettings(item.agentDir) });
    } catch (error) {
      throw new Error(`agent file rejected, nothing was saved: ${error instanceof Error ? error.message : String(error)}`);
    }
    const previous = { text: readFileSync(item.specPath, "utf8"), spec: item.spec, runtime: item.runtime };
    writeFileDurable(item.specPath, `${JSON.stringify(spec, null, 2)}\n`);
    item.spec = spec;
    // The unlock file may have been created since this agent started; rediscover it.
    const file = findUnlockFile(item.agentDir);
    item.runtime = { env: item.runtime.env, configPath: item.runtime.configPath, ...(file === undefined ? {} : { walletPasswordFile: file }) };
    const at = running.findIndex((owned) => owned.id === item.id);
    if (at >= 0) {
      const [owned] = running.splice(at, 1);
      // Streams before store, as at shutdown.
      await consoleServer?.closeStreams(item.id);
      await owned.listener?.close();
      await owned.agent.close();
    }
    try { await start(item, at >= 0 ? at : running.length); }
    catch (error) {
      // A transient reopen failure must not leave a file the next start cannot load.
      writeFileDurable(item.specPath, previous.text);
      item.spec = previous.spec;
      item.runtime = previous.runtime;
      o.log(`${item.id}: stopped, could not reopen: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  try {
    for (const item of agents) {
      if (o.signal.aborted) return;
      try { await start(item); }
      catch (error) {
        // A stop request during one open must still shut down cleanly.
        if (o.signal.aborted) return;
        throw error;
      }
    }
    if (o.console) {
      consoleServer = await startConsole({
        port: o.console.port, token: randomBytes(32).toString("hex"), env: o.env,
        agents: () => running.flatMap(({ id, spec, agent }) => {
          const item = agents.find((candidate) => candidate.id === id);
          if (!item || !agent.operator || !agent.status || !agent.transcript || !agent.changes) return [];
          return [{ id, spec, agent: { operator: agent.operator, status: agent.status, transcript: agent.transcript, changes: agent.changes }, saveSpec: (next: AgentSpec) => reopen(item, next), host: (taskIds: string[]) => facts(item, taskIds) }];
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
    // A save still in flight can add an agent while these close; keep going until none remain.
    while (running.length) {
      const batch = running.splice(0, running.length);
      // Close streams before stores so no event can be ACKed after its owner closed.
      await Promise.allSettled(batch.map(async ({ listener }) => listener?.close()));
      await Promise.all(batch.map(({ agent }) => agent.close()));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { env: { type: "string", default: "production" }, "wallet-password-file": { type: "string" }, console: { type: "boolean", default: false }, "console-port": { type: "string", default: "7070" } } });
  const file = values["wallet-password-file"];
  if (file !== undefined && !file) throw new Error("--wallet-password-file needs a path");
  const portText = values["console-port"];
  // Number("") is 0 and Number("0x1f") is 31; only plain decimal digits are a port.
  if (!/^\d+$/.test(portText)) throw new Error("--console-port must be a port number");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--console-port must be a port number");
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  await runAgents({ agentsDir: "agents", env: taskfastEnv(values.env), ...(file === undefined ? {} : { walletPasswordFile: resolve(file) }), ...(values.console ? { console: { port } } : {}), signal: stop.signal, log: (line) => process.stdout.write(`${line}\n`) });
}
