// What an agent is and how it behaves: agent.json (gh#1538) plus the agent folder's INSTRUCTIONS.md.
export type Role = "poster" | "worker" | "both";

// Every temperament is honest. The prompt uses its manner phrase (prompt.ts MANNER).
export type Temperament = "patient" | "brisk" | "exacting" | "easygoing" | "curt";

// competence, diligence and priceSensitivity are 0..1. Seeded decisions read them;
// prompts never interpolate them.
export interface Dials {
  competence: number;
  diligence: number;
  priceSensitivity: number;
  temperament: Temperament;
}

// agent.json: what code reads or enforces.
export interface AgentFile {
  role: Role;
  // Pi provider and model, "provider:model" (spec.ts splitModel, model.ts). The model decides the agent's
  // actions through tool calls; code enforces the once-only rule and, if set, limits.
  model: string;
  dials: Dials;
  // The agent's own spending limits, both optional. Without them nothing is checked.
  limits?: Limits;
  // Delay after each host work check, in whole minutes (1..1440). Omitted means 15.
  pollIntervalMinutes?: number;
}

// The whole agent: agent.json plus the user's own words from INSTRUCTIONS.md, which open
// the system prompt (prompt.ts): who the agent is, its business, goals and budget.
export interface AgentSpec extends AgentFile {
  instructions: string;
}

export interface Limits {
  // Most one money action may commit: a bid's price when escrow_sign funds it, the
  // submission fee when post_task posts, or a task's stake when bond_post posts its
  // performance bond. A bond is spend while it is at risk; a later refund does not
  // credit the day back. A task's budget is not committed at post.
  perJobUsd?: number;
  // Most committed across money actions in one UTC day.
  dailyUsd?: number;
}

// Money committed today (UTC), kept with or without limits.
export interface Spend {
  day: string;
  usd: number;
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// One marketplace event as `taskfast events stream` prints it. Only event_id and
// event are relied on; the rest passes through to the agent untouched.
export interface MarketEvent {
  event_id: string;
  event: string;
  task_id?: string | null;
  timestamp?: string;
  data?: Json;
}

// Where this agent's CLI points: its own env and its own TaskFast config.
// `prod` is deliberate: users run their own agents on production, like the taskfast
// CLI (owner decision, gh#1514).
export const ENVS = ["prod", "staging", "local"] as const;
export type Env = (typeof ENVS)[number];
export interface Runtime {
  env: Env;
  configPath: string;
  // Optional host-only unlock path. Never a model input or child environment value.
  walletPasswordFile?: string;
}

// A settled marketplace action. In-flight reservations live in policy.ts; these
// outcomes remain the input to the pure money accounting helpers.
export interface ActionRecord {
  status: "done" | "failed" | "uncertain";
  at: string;
}
