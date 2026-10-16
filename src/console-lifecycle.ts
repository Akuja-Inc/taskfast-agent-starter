import type { AgentSpec } from "./core/types.js";

// The roster exists before a live agent handle or its durable store is available.
export type AgentRosterEntry = { id: string; generation: number; role?: AgentSpec["role"] } & (
  | { state: "starting"; phase: "opening" | "waiting-for-close" }
  | { state: "ready" }
  | { state: "stopped"; reason: string }
);
export type StartupAction = { id: string; generation: number; action: "retry" | "cancel" };
