// What an agent is and how it behaves: the agent-file format (gh#1538).
export interface Character {
  name: string;
  businessName: string;
  businessDescription: string;
  goals: string;
  // Per-job budget when posting. A worker-only agent has none.
  budgetUsd?: number;
}

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

export interface AgentSpec {
  role: Role;
  // Pi provider and model, "provider:model" (spec.ts splitModel, model.ts). The model decides the agent's
  // actions through tool calls; code enforces the once-only rule and, if set, limits.
  model: string;
  character: Character;
  dials: Dials;
  // The agent's own spending limits, both optional. Without them nothing is checked.
  limits?: Limits;
}

export interface Limits {
  // Most one money action may commit: a bid's price when escrow_sign funds it, or the
  // submission fee when post_task posts. A task's budget is not committed at post.
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
