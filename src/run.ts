import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { PersonaActor } from "./core/actors.js";
import { parseAgentSpec } from "./core/spec.js";
import type { Env } from "./core/types.js";

// The environment names the kit's commands take, and the taskfast CLI's name for each.
// development is a TaskFast server on this machine (127.0.0.1:4000).
export const ENVIRONMENTS = { production: "prod", staging: "staging", development: "local" } as const satisfies Record<string, Env>;
export type Environment = keyof typeof ENVIRONMENTS;

// A kit environment name as the CLI's name for it.
export function taskfastEnv(name: string): Env {
  if (Object.hasOwn(ENVIRONMENTS, name)) return ENVIRONMENTS[name as Environment];
  throw new Error(`--env must be production, staging or development, not ${JSON.stringify(name)}`);
}

export interface RunOptions {
  agentsDir: string;
  env: Env;
  actorFor(id: string): PersonaActor;
  signal: AbortSignal;
  log(line: string): void;
  pingEveryMs?: number;
}

// Starts every agent under agents/<id>/ (its agent.json, and the .taskfast/config.json
// `taskfast init` wrote there), then pings each one now and every pingEveryMs (default
// 15 min) until the signal aborts. Each agent listens, decides and acts on its own in
// the runtime; the ping only wakes it, because the runtime has no timers and new
// open-market tasks arrive as no event.
export async function runAgents(o: RunOptions): Promise<void> {
  const ids = existsSync(o.agentsDir) ? readdirSync(o.agentsDir).filter((id) => existsSync(join(o.agentsDir, id, "agent.json"))) : [];
  if (!ids.length) throw new Error(`no agents: put one in ${o.agentsDir}/<id>/agent.json (copy one from examples/)`);
  for (const id of ids) {
    const spec = parseAgentSpec(JSON.parse(readFileSync(join(o.agentsDir, id, "agent.json"), "utf8")));
    const configPath = resolve(o.agentsDir, id, ".taskfast", "config.json");
    if (!existsSync(configPath)) throw new Error(`${id}: no ${configPath}; run \`taskfast --env ${o.env} init\` in ${join(o.agentsDir, id)}`);
    await o.actorFor(id).init(spec, { env: o.env, configPath });
  }
  o.log(`running ${ids.length} agent(s) on ${o.env}: ${ids.join(", ")}`);
  while (!o.signal.aborted) {
    await Promise.all(ids.map((id) => o.actorFor(id).ping().catch((e: unknown) => o.log(`${id}: ping failed: ${e instanceof Error ? e.message : String(e)}`))));
    await sleep(o.pingEveryMs ?? 900_000, undefined, { signal: o.signal }).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { env: { type: "string", default: "production" } } });
  const env = taskfastEnv(values.env);
  // The typed client `pnpm generate` writes; built path is dist/src/run.js.
  const { actors } = (await import(new URL("../../generated/index.js", import.meta.url).href)) as { actors: { Persona: { get(id: string): PersonaActor } } };
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  await runAgents({ agentsDir: "agents", env, actorFor: (id) => actors.Persona.get(id), signal: stop.signal, log: console.log });
}
