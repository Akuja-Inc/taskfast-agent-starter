import type { MarketEvent } from "./types.js";

// The one rule for what an agent can store, used by both the pump and
// MarketplaceAgent.deliver so the two cannot drift. Returns why a value is not a deliverable
// event, or null when it is.
export function eventProblem(v: unknown): string | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return "not an object";
  const o = v as Record<string, unknown>;
  if (typeof o.event_id !== "string" || !o.event_id) return "no event_id";
  // The id is written back to the CLI as one ack line; a line break would ack a
  // second, attacker-chosen id.
  if (/[\r\n]/.test(o.event_id)) return "event_id has a line break";
  if (typeof o.event !== "string" || !o.event) return "no event name";
  return null;
}

export const isMarketEvent = (v: unknown): v is MarketEvent => eventProblem(v) === null;
