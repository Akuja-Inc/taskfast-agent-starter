import { defineDoc } from "@earendil-works/pi-durable";

// What the user has told the host to do with this agent. Session-scoped like Policy,
// so reset and compaction keep it; kept apart from Policy, whose version never moves.
export type OperatorState = {
  frozen: boolean;
};
export const initialOperator = (): OperatorState => ({ frozen: false });
export const Operator = defineDoc<OperatorState>({
  kind: "taskfast.operator", version: 1, scope: "session", initial: initialOperator,
});
export const FROZEN = "spending is frozen by your operator";
