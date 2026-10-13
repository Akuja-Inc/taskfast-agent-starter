import { defineDoc } from "@earendil-works/pi-durable";

// What the user has told the host to do with this agent. Session-scoped like Policy,
// so reset and compaction keep it; kept apart from Policy, whose version never moves.
export type OperatorState = {
  // No money tool may reserve.
  frozen: boolean;
  // Events are still admitted and acknowledged; no new model work starts.
  paused: boolean;
};
export const initialOperator = (): OperatorState => ({ frozen: false, paused: false });
export const Operator = defineDoc<OperatorState>({
  kind: "taskfast.operator", version: 1, scope: "session", initial: initialOperator,
});
export const FROZEN = "spending is frozen by your operator";
