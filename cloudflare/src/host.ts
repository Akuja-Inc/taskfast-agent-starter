// One marketplace agent inside one Durable Object. The DO is single-instance, so it
// replaces the local owner lock; its SQLite storage holds the whole ledger. Pure of
// `cloudflare:workers`, so Node tests drive it with any Pi storage.
import type { Models } from "@earendil-works/pi-ai";
import type { Storage } from "@earendil-works/pi-durable";
import { openMarketplaceAgent, type MarketplaceAgent } from "../../src/core/agent.js";
import type { Command } from "../../src/core/policy.js";
import { POLL_MINUTES } from "../../src/core/spec.js";
import type { AgentSpec, Env } from "../../src/core/types.js";
import { view } from "../../src/console.js";
import { reply } from "./gate.js";

export interface HostOptions {
  id: string;
  env: Env;
  // Reads and checks agent.json, INSTRUCTIONS.md and the secrets; throws why it cannot.
  load(): Promise<{ spec: AgentSpec; models: Models }>;
  storage(): Promise<Storage>;
  command: Command;
  log?: (line: string) => void;
}
export interface AgentHost {
  fetch(request: Request): Promise<Response>;
  // Runs one work check to completion and returns the delay before the next one.
  alarm(): Promise<number>;
  // A DO never closes its agent; tests do.
  close(): Promise<void>;
}

// The CLI path arrives in #144 PR4. Until then every marketplace command is a known
// refusal before anything is sent, so policy releases its reservation.
export const unavailable: Command = async () => ({ outcome: "failed", error: "unavailable: the marketplace path is not deployed yet" });

// A fixed path the DO never reads: the agent's folder is the bundle and its secrets.
const CONFIG_PATH = "/bundle/agent/.taskfast/config.json";
export const RETRY_MS = 60_000;

export function agentHost(o: HostOptions): AgentHost {
  const log = (line: string) => o.log?.(`${o.id}: ${line}`);
  let opening: Promise<{ agent: MarketplaceAgent; spec: AgentSpec }> | undefined;
  let failure: string | undefined;
  let role: AgentSpec["role"] | undefined;
  // Concurrent requests share one open; a failure is kept for the console and retried on the next request.
  function open() {
    return opening ??= (async () => {
      const { spec, models } = await o.load();
      role = spec.role;
      const agent = await openMarketplaceAgent({ spec, models, runtime: { env: o.env, configPath: CONFIG_PATH }, storePath: CONFIG_PATH, openStorage: () => o.storage(), command: o.command, log });
      failure = undefined;
      void agent.closed.then((end) => {
        if (end.reason !== "failed") return;
        failure = `session failed: ${end.error instanceof Error ? end.error.message : String(end.error)}`;
        log(failure);
        opening = undefined;
      });
      return { agent, spec };
    })().catch((error: unknown) => {
      failure = error instanceof Error ? error.message : String(error);
      log(`stopped: ${failure}`);
      opening = undefined;
      throw error;
    });
  }
  const entry = () => failure === undefined
    ? { id: o.id, generation: 1, state: "ready" as const, ...(role ? { role } : {}) }
    : { id: o.id, generation: 1, state: "stopped" as const, reason: failure, ...(role ? { role } : {}) };

  return {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") return reply(405, { error: "this console is read-only for now" });
      await open().catch(() => {});
      if (path === "/api/agents") return reply(200, { env: o.env, agents: [entry()] });
      const match = /^\/api\/agents\/([^/]+)$/.exec(path);
      let id: string | undefined;
      try { id = match ? decodeURIComponent(match[1]) : undefined; } catch { id = undefined; }
      if (id !== o.id) return reply(404, { error: "not found" });
      if (failure !== undefined || !opening) return reply(409, { error: "agent is not ready" });
      const { agent, spec } = await opening;
      return reply(200, await view(o.env, { id: o.id, spec, agent }));
    },
    async alarm() {
      let opened: Awaited<ReturnType<typeof open>>;
      try { opened = await open(); } catch { return RETRY_MS; }
      const { agent, spec } = opened;
      // The DO may be evicted once no request or alarm is running, so the turn is
      // awaited here rather than left in the background.
      try { await agent.ping(); await agent.waitForIdle(); }
      catch (error) { log(`ping failed: ${error instanceof Error ? error.message : String(error)}`); }
      return (spec.pollIntervalMinutes ?? POLL_MINUTES.default) * 60_000;
    },
    async close() {
      const open = opening;
      opening = undefined;
      await (await open?.catch(() => undefined))?.agent.close();
    },
  };
}
