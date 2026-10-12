import type { CliResult } from "./cli.js";
import { findBid } from "./money.js";
import { UUID, type Party } from "./tools.js";
import type { Counterparties } from "./types.js";

// The counterparty rule, owned here: an agent whose host set `counterparties` may only
// run a write whose other side is on that list. Checked before reservation; a
// failed read or missing worker is refused. The CLI/server also enforces the
// marketplace's current assignment when the write runs.

// Validates a host-supplied list at init. Throws on a wrong shape.
export function parseCounterparties(c: unknown): Counterparties {
  const ids = (v: unknown, name: string) => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && UUID.test(x))) throw new Error(`runtime.counterparties.${name} must be a list of UUIDs`);
    return [...v] as string[];
  };
  const o = c as { me?: unknown; accounts?: unknown; agents?: unknown } | null;
  if (!o || typeof o !== "object") throw new Error("runtime.counterparties must be an object");
  if (typeof o.me !== "string" || !UUID.test(o.me)) throw new Error("runtime.counterparties.me must be a UUID");
  return { me: o.me, accounts: ids(o.accounts, "accounts"), agents: ids(o.agents, "agents") };
}

type Task = { poster_id?: unknown; worker_agent_id?: unknown } | undefined;

// Null when the write may run; otherwise the reason it is refused.
export async function counterpartyRefusal(party: Party, input: Record<string, unknown>, c: Counterparties, read: (args: string[]) => Promise<CliResult>): Promise<string | null> {
  if (party === "bidder") {
    const bid = await findBid(input, read);
    if (typeof bid === "string") return `could not confirm who you are dealing with: ${bid}`;
    return verdict(bid.agent_id, c.agents, "bidder");
  }
  // `taskfast task get` prints { task: {...} }, dropping null fields.
  const r = await read(["task", "get", "--", String(input.task_id)]);
  if (r.outcome !== "ok") return `could not confirm who you are dealing with: ${r.error ?? r.outcome}`;
  const task = (r.data as { task?: Task } | null)?.task;
  const side = party === "other" ? (task?.worker_agent_id === c.me ? "poster" : "worker") : party;
  // A task's poster is an account; its worker is an agent.
  return side === "poster" ? verdict(task?.poster_id, c.accounts, "poster") : verdict(task?.worker_agent_id, c.agents, "worker");
}

function verdict(id: unknown, allowed: string[], side: string): string | null {
  if (typeof id !== "string" || !id) return `refused: this task has no ${side} yet to confirm`;
  return allowed.includes(id) ? null : "refused: you do not deal with this party";
}
