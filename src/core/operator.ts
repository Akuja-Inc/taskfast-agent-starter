import { defineDoc, type SubmissionId } from "@earendil-works/pi-durable";

export type QueuedOperatorMessage = { requestId: string; text: string; mode: "followUp" | "steer" };
export type SteerResult = "steered" | "already_placed" | "not_found";
export type WithdrawResult = "withdrawn" | "already_placed" | "not_found";

// What the user has told the host to do with this agent. Session-scoped like Policy,
// so reset and compaction keep it; kept apart from Policy, whose version never moves.
export type OperatorState = {
  // No money tool may reserve.
  frozen: boolean;
  // Events are still admitted and acknowledged; no new model work starts.
  paused: boolean;
  // Messages not yet handed to the conversation, oldest first.
  messages: { requestId: string; text: string; mode?: "followUp" | "steer" }[];
  // Additive v1 fields: older documents can omit them. Intents precede Pi abort.
  pendingSteers?: Record<string, { submission: SubmissionId; text: string }>;
  // Original admission order survives replacement with a new Pi submission ID.
  queuedOrder?: string[];
  // Permanent, never-pruned tombstones: retrying a withdrawn send cannot re-admit it.
  withdrawn?: Record<string, true>;
  // Standing orders, read into every system prompt. Only the user changes them.
  orders: string[];
  // Alerts the user has looked into, by action key or event id, with when. Never
  // changes the ledger: an uncertain action stays uncertain.
  checked: Record<string, string>;
};
export const initialOperator = (): OperatorState => ({ frozen: false, paused: false, messages: [], orders: [], checked: {} });
// How the conversation tells the user's words from the host's own inputs.
export const MESSAGE_PREFIX = "Message from your operator:\n";
export const Operator = defineDoc<OperatorState>({
  kind: "taskfast.operator", version: 1, scope: "session", initial: initialOperator,
});
export const FROZEN = "spending is frozen by your operator";
