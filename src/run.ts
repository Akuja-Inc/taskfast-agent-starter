import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { openMarketplaceAgent, type MarketplaceAgent } from "./core/agent.js";
import { startListener } from "./core/listener.js";
import { parseAgentSpec } from "./core/spec.js";
import { parseWalletPasswordFile } from "./core/cli.js";
import { PASSWORD_PATH, folderFile } from "./core/folder.js";
import type { AgentSpec, Env, Runtime } from "./core/types.js";

export const ENVIRONMENTS = { production: "prod", staging: "staging", development: "local" } as const satisfies Record<string, Env>;
export type Environment = keyof typeof ENVIRONMENTS;
export function taskfastEnv(name: string): Env {
  const environment = Object.entries(ENVIRONMENTS).find(([key]) => key === name);
  if (!environment) throw new Error(`--env must be production, staging or development, not ${JSON.stringify(name)}`);
  return environment[1];
}
export type AgentHandle = Pick<MarketplaceAgent, "deliver" | "ping" | "close">;
export interface RunOptions {
  agentsDir: string;
  env: Env;
  walletPasswordFile?: string;
  openAgent?(agent: { id: string; spec: AgentSpec; runtime: Runtime; storePath: string }): Promise<AgentHandle>;
  listen?: typeof startListener;
  signal: AbortSignal;
  log(line: string): void;
  pingEveryMs?: number;
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
    const localPassword = folderFile({ agentDir, path: PASSWORD_PATH, resource: "wallet unlock file" });
    const file = existsSync(localPassword) ? localPassword : walletPasswordFile;
    return { id, spec, storePath: folderFile({ agentDir, path: `.pi-state/${o.env}/state.sqlite`, resource: "permanent state" }), runtime: { env: o.env, configPath, ...(file === undefined ? {} : { walletPasswordFile: file }) } };
  });
  const running: { id: string; agent: AgentHandle; listener?: ReturnType<typeof startListener> }[] = [];
  try {
    for (const item of agents) {
      const agent = o.openAgent
        ? await o.openAgent(item)
        : await openMarketplaceAgent({ spec: item.spec, runtime: item.runtime, storePath: item.storePath, log: (line) => o.log(`${item.id}: ${line}`) });
      const owned: typeof running[number] = { id: item.id, agent };
      running.push(owned);
      owned.listener = (o.listen ?? startListener)({ runtime: item.runtime, deliver: (event) => agent.deliver(event), log: (line) => o.log(`${item.id}: ${line}`) });
    }
    o.log(`running ${ids.length} agent(s) on ${o.env}: ${ids.join(", ")}`);
    while (!o.signal.aborted) {
      await Promise.all(running.map(({ id, agent }) => agent.ping().catch((error: unknown) => o.log(`${id}: ping failed: ${error instanceof Error ? error.message : String(error)}`))));
      await sleep(o.pingEveryMs ?? 900_000, undefined, { signal: o.signal }).catch(() => {});
    }
  } finally {
    // Close streams before stores so no event can be ACKed after its owner closed.
    await Promise.allSettled(running.map(async ({ listener }) => listener?.close()));
    await Promise.all(running.map(({ agent }) => agent.close()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { env: { type: "string", default: "production" }, "wallet-password-file": { type: "string" } } });
  const file = values["wallet-password-file"];
  if (file !== undefined && !file) throw new Error("--wallet-password-file needs a path");
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  await runAgents({ agentsDir: "agents", env: taskfastEnv(values.env), ...(file === undefined ? {} : { walletPasswordFile: resolve(file) }), signal: stop.signal, log: (line) => process.stdout.write(`${line}\n`) });
}
