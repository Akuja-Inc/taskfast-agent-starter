// The Cloudflare entry for one owner's agent (#144). The Worker checks Access and
// the console token before any Durable Object is touched; the Agent DO owns the
// store; the Cli Container runs one `taskfast` command per call.
import { DurableObject } from "cloudflare:workers";
import { Container } from "@cloudflare/containers";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createAgentModels } from "../../src/core/model.js";
import { parseAgentFile, parseAgentSpec } from "../../src/core/spec.js";
import { ENVS, type Env as CliEnv } from "../../src/core/types.js";
// Text modules from the owner's git-ignored cloudflare/agent/ folder (wrangler.jsonc rules).
import agentFile from "../agent/agent.json";
import instructions from "../agent/INSTRUCTIONS.md";
import { gate } from "./gate.js";
import { agentHost, RETRY_MS, type AgentHost } from "./host.js";
import { containerCommand } from "./container.js";
import { parseSecrets } from "./secrets.js";

interface Env {
  AGENT: DurableObjectNamespace<Agent>;
  CLI: DurableObjectNamespace<Cli>;
  AGENT_ID: string;
  CLI_ENV: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  CONSOLE_TOKEN: string;
  TASKFAST_CONFIG: string;
  // Provider settings as one JSON object of NAME: value, like the folder's .env.
  MODEL_SETTINGS?: string;
  // The encrypted keystore's JSON and its one-line password; only signing commands get them.
  WALLET_KEYSTORE?: string;
  WALLET_PASSWORD?: string;
}

export class Cli extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
}

export class Agent extends DurableObject<Env> {
  host: AgentHost;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const cliEnv = env.CLI_ENV as CliEnv;
    // A bad secret stops the agent with its reason when it opens (load below).
    let secrets: ReturnType<typeof parseSecrets> | undefined;
    try { secrets = parseSecrets(env); } catch { secrets = undefined; }
    const cli = () => env.CLI.getByName(env.AGENT_ID);
    this.host = agentHost({
      id: env.AGENT_ID, env: cliEnv,
      load: async () => {
        if (!ENVS.includes(cliEnv)) throw new Error(`CLI_ENV must be one of ${ENVS.join(", ")}`);
        const { settings } = parseSecrets(env);
        const spec = parseAgentSpec({ ...parseAgentFile(agentFile), instructions });
        return { spec, models: await createAgentModels(spec.model, { agentDir: "/bundle/agent", settings }) };
      },
      storage: () => openDurableObjectSqliteStorage(ctx.storage),
      command: containerCommand({
        config: secrets?.config ?? "",
        ...(secrets?.wallet ? { wallet: secrets.wallet } : {}),
        // One Container instance per agent, addressed only through this binding.
        ready: async () => (await cli().fetch("http://cli/health")).ok,
        call: (body) => cli().fetch("http://cli/run", { method: "POST", body: JSON.stringify(body) }),
      }),
      log: (line) => console.log(line),
    });
    // Each new instance opens the store, which turns an interrupted reservation into
    // uncertain, and makes sure a work check is scheduled.
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now());
    });
  }
  fetch(request: Request): Promise<Response> { return this.host.fetch(request); }
  async alarm(): Promise<void> {
    // Schedule the retry before the turn: an alarm cut off by a deploy or its
    // 15-minute limit must still leave a next check, or a quiet agent never wakes.
    await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
    const delay = await this.host.alarm();
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const decision = await gate(request, { access: { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD }, token: env.CONSOLE_TOKEN });
    if (decision !== "forward") return decision;
    return env.AGENT.getByName(env.AGENT_ID).fetch(request);
  },
} satisfies ExportedHandler<Env>;
