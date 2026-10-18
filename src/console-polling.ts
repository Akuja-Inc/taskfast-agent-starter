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
  // buildTimeline() marks a call comparable only for one successful text result.
  // Raw strings compare every field, so any difference keeps the turn visible.
  const observation = (turn: Turn): { signature: string; scope: string[] } | null => {
    if (turn.kind !== "poll" || turn.complete !== true) return null;
    const final = turn.replies.at(-1), calls = turn.replies.flatMap((reply) => reply.calls);
    if (!final?.text.trim() || final.calls.length || !calls.length) return null;
    if (!calls.every((call) => Object.hasOwn(reads, call.name) && call.comparable === true)) return null;
    // Exact prose equality is intentional. Identical reads cannot prove that a
    // differently worded reply contains no new warning or decision.
    return {
      signature: JSON.stringify([turn.text, calls.map((call) => [call.name, call.arguments, call.result]), turn.replies.map((reply) => [reply.text, reply.tasks])]),
      scope: [...new Set(calls.map((call) => reads[call.name]))],
    };
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
