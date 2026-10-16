// The link `pnpm agents --console` prints, from the argument or TASKFAST_CONSOLE_URL.
// Errors never repeat the link: it holds the token.
import type { AgentRosterEntry, StartupAction } from "../console-lifecycle.js";

export type Listing = { env: "local" | "staging" | "prod"; agents: AgentRosterEntry[] };
// Old fixture hosts expose only id/role. Never interpret an unknown state as ready.
export function roster(value: unknown): Listing {
  if (!value || typeof value !== "object" || !("env" in value) || !("agents" in value)
    || !["local", "staging", "prod"].includes(String(value.env)) || !Array.isArray(value.agents)) throw new Error("Invalid agent roster.");
  const agents = value.agents.map((row: unknown): AgentRosterEntry => {
    if (!row || typeof row !== "object" || !("id" in row) || typeof row.id !== "string") throw new Error("Invalid agent roster entry.");
    const role: AgentRosterEntry["role"] = "role" in row && (row.role === "worker" || row.role === "poster" || row.role === "both") ? row.role : undefined;
    if (!("state" in row)) return { id: row.id, role, generation: 0, state: "ready" };
    if (!("generation" in row) || typeof row.generation !== "number" || !Number.isSafeInteger(row.generation) || row.generation < 0) throw new Error("Invalid agent generation.");
    const base = { id: row.id, role, generation: row.generation };
    if (row.state === "ready") return { ...base, state: "ready" };
    if (row.state === "starting" && "phase" in row && (row.phase === "opening" || row.phase === "waiting-for-close")) return { ...base, state: "starting", phase: row.phase };
    if (row.state === "stopped" && "reason" in row && typeof row.reason === "string") return { ...base, state: "stopped", reason: row.reason };
    throw new Error("Invalid agent startup state.");
  });
  if (value.env !== "local" && value.env !== "staging" && value.env !== "prod") throw new Error("Invalid environment.");
  return { env: value.env, agents };
}
export function sameAgent(a: Pick<AgentRosterEntry, "id" | "generation"> | undefined, b: Pick<AgentRosterEntry, "id" | "generation"> | undefined): boolean {
  return !!a && !!b && a.id === b.id && a.generation === b.generation;
}
export function startupAllowed(intent: StartupAction, current: AgentRosterEntry | undefined): boolean {
  return sameAgent(intent, current) && (intent.action === "cancel" ? current?.state === "starting" : current?.state === "stopped");
}

const USAGE = "pnpm tui '<link printed by pnpm agents --console>', or set TASKFAST_CONSOLE_URL";
export function parseLink(arg: string | undefined, env: string | undefined): { origin: string; token: string } {
  const link = arg ?? env;
  if (!link) throw new Error(`no console link: ${USAGE}`);
  let url: URL;
  try { url = new URL(link); } catch { throw new Error(`not a console link: ${USAGE}`); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error(`the console runs on http://127.0.0.1 only: ${USAGE}`);
  const token = /^#token=([0-9a-f]{64})$/.exec(url.hash)?.[1];
  if (!token) throw new Error(`the link has no #token=: ${USAGE}`);
  return { origin: url.origin, token };
}
