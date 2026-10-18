import type { Turn } from "./core/timeline.js";

export type PollRow =
  | { kind: "turn"; index: number }
  | { kind: "unchanged"; from: number; to: number; scope: string[] };

// Browser-only projection. This function is also embedded into the console page,
// so keep its runtime dependencies inside it. It never edits the source turns.
export function foldPolls(turns: readonly Turn[]): PollRow[] {
  // Explicit read allowlist: a new tool cannot silently become foldable. Tests
  // check this boundary against the tool table; MCP/skills/notes stay excluded.
  const reads: Record<string, string> = {
    me: "Agent profile", wallet_balance: "Wallet balance", discover: "Work discovery",
    task_get: "Task details", task_list: "Task lists", bid_list: "Bids", task_bids: "Task bids",
    message_list: "Messages", message_conversations: "Conversations", platform_config: "Platform settings",
    agent_get: "Agent details", agent_list: "Agent lists", dispute_get: "Disputes",
    artifact_list: "Artifacts", artifact_get: "Artifact details", payment_get: "Payment details",
    payment_list: "Payments", review_list: "Reviews",
  };
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  // Every field participates. Only object key order is incidental; array order,
  // amounts, deadlines, cursors and timestamps are not silently discarded.
  const canonical = (value: unknown, depth = 0): string => {
    if (depth > 64) throw new Error("Response too deeply nested to compare");
    if (Array.isArray(value)) return "[" + value.map((item) => canonical(item, depth + 1)).join(",") + "]";
    if (object(value)) return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key], depth + 1)).join(",") + "}";
    if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
    throw new Error("Non-JSON comparison value");
  };
  const observation = (turn: Turn): { signature: string; scope: string[] } | null => {
    if (turn.kind !== "poll" || turn.complete !== true || !turn.replies.length) return null;
    const final = turn.replies.at(-1);
    if (!final || !final.text.trim() || final.calls.length) return null;
    const scope = new Set<string>();
    const calls = turn.replies.flatMap((reply) => reply.calls);
    if (!calls.length) return null;
    try {
      const evidence = calls.map((call) => {
        const label = Object.hasOwn(reads, call.name) ? reads[call.name] : undefined;
        if (!label || call.outcome !== "ok" || call.comparable !== true || !call.result || call.result.length > 131_072 || !object(call.arguments)) throw new Error("Unsupported observation");
        const result: unknown = JSON.parse(call.result);
        if ((!object(result) && !Array.isArray(result)) || (object(result) && (!Object.keys(result).length || ["error", "failed", "refused", "uncertain", "skipped"].some((key) => Object.hasOwn(result, key))))) throw new Error("No comparable response");
        if (call.name === "task_list" && (!object(result) || !Array.isArray(result.tasks))) throw new Error("Unsupported task-list shape");
        scope.add(label);
        return [call.name, call.arguments, result];
      });
      // Exact prose equality is intentional. Identical reads cannot prove that a
      // differently worded reply contains no new warning or decision.
      const replies = turn.replies.map((reply) => ({ text: reply.text, tasks: reply.tasks }));
      if (replies.some((reply) => reply.tasks.some((task) => !Object.hasOwn(reads, task.via)))) return null;
      return { signature: canonical([turn.text, evidence, replies]), scope: [...scope] };
    } catch { return null; }
  };
  const rows: PollRow[] = [];
  let previous: ReturnType<typeof observation> = null;
  for (const [index, turn] of turns.entries()) {
    const current = observation(turn);
    if (current && previous && current.signature === previous.signature) {
      const last = rows.at(-1);
      if (last?.kind === "unchanged" && last.to === index) last.to = index + 1;
      else rows.push({ kind: "unchanged", from: index, to: index + 1, scope: current.scope });
    } else rows.push({ kind: "turn", index });
    previous = current;
  }
  return rows;
}
