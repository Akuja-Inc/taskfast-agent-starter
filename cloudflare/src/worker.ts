// The Cloudflare entry for one owner's agent (#144). The Worker checks Access and
// the console token before any Durable Object is touched; the Agent DO owns the
// store; the Cli Container runs one `taskfast` command per call.
import { mkdirSync } from "node:fs";
import { DurableObject } from "cloudflare:workers";
import { Container } from "@cloudflare/containers";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createAgentModels } from "../../src/core/model.js";
import { parseAgentFile, parseAgentSpec } from "../../src/core/spec.js";
import { ENVS, type Env as CliEnv } from "../../src/core/types.js";
// Text modules from the owner's git-ignored cloudflare/agent/ folder (wrangler.jsonc rules).
import agentFile from "../agent/agent.json";
import instructions from "../agent/INSTRUCTIONS.md";
import { gate, reply } from "./gate.js";
import { agentHost, RETRY_MS, type AgentHost } from "./host.js";
import { containerCommand } from "./container.js";
import { parseSecrets } from "./secrets.js";
import { MAX_WEBHOOK_BYTES, verifyWebhook, WEBHOOK_PATH } from "./webhook.js";

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
  // The signing secret `taskfast webhook register` returned once.
  WEBHOOK_SECRET?: string;
}

// Stands in for the agent's folder. Policy writes a submit's files here just before
// dispatch; the DO's memory-backed /tmp loses them on eviction, which is the uncertain path.
const FOLDER = "/tmp/agent";

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
    mkdirSync(FOLDER, { recursive: true, mode: 0o700 });
    this.host = agentHost({
      id: env.AGENT_ID, env: cliEnv,
      load: async () => {
        if (!ENVS.includes(cliEnv)) throw new Error(`CLI_ENV must be one of ${ENVS.join(", ")}`);
        const { settings } = parseSecrets(env);
        const spec = parseAgentSpec({ ...parseAgentFile(agentFile), instructions });
        return { spec, models: await createAgentModels(spec.model, { agentDir: FOLDER, settings }) };
      },
      storage: () => openDurableObjectSqliteStorage(ctx.storage),
      command: containerCommand({
        config: secrets?.config ?? "",
        ...(secrets?.wallet ? { wallet: secrets.wallet } : {}),
        folder: FOLDER,
        // One Container instance per agent, addressed only through this binding.
        ready: async () => (await cli().fetch("http://cli/health")).ok,
        call: (body) => cli().fetch("http://cli/run", { method: "POST", body: JSON.stringify(body) }),
      }),
      folder: FOLDER,
      log: (line) => console.log(line),
    });
    // Each new instance opens the store, which turns an interrupted reservation into
    // uncertain, and makes sure a work check is scheduled.
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now());
    });
  }
  fetch(request: Request): Promise<Response> { return this.host.fetch(request); }
  // Called by the Worker over RPC after it checked the signature; never public.
  async deliver(body: string): Promise<number> {
    const { status, work } = await this.host.deliver(body);
    // Keep the DO alive until the admitted event's turn finishes.
    if (work) this.ctx.waitUntil(work);
    return status;
  }
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
    // Outside Access: TaskFast posts here, and the HMAC is the only credential.
    if (new URL(request.url).pathname === WEBHOOK_PATH) {
      if (request.method !== "POST") return reply(405, { error: "POST only" });
      if (Number(request.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) return reply(413, { error: "too large" });
      const body = await request.text();
      if (body.length > MAX_WEBHOOK_BYTES) return reply(413, { error: "too large" });
      const signed = verifyWebhook(body, request.headers, env.WEBHOOK_SECRET ?? "");
      if (!signed.ok) return reply(401, { error: signed.reason });
      const status = await env.AGENT.getByName(env.AGENT_ID).deliver(body);
      return reply(status, status === 200 ? { ok: true } : { error: "not admitted; retry" });
    }
    const decision = await gate(request, { access: { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD }, token: env.CONSOLE_TOKEN });
    if (decision !== "forward") return decision;
    return env.AGENT.getByName(env.AGENT_ID).fetch(request);
  },
} satisfies ExportedHandler<Env>;
