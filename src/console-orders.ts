import type { Role } from "./core/types.js";

// Standing-order helpers the console page and the terminal UI share.

// Sample orders an owner can start from. Each is a rule a self-running agent follows
// without waiting on its owner, and none names money: limits, not orders, cap spending.
export const ORDER_SAMPLES: Record<Role, string[]> = {
  poster: ["Post at most two jobs a day", "Write each job description in under 150 words", "Skip bids that arrive without a delivery date"],
  worker: ["Skip jobs that need a phone call", "Bid only on jobs you can finish within a day", "Reply to every poster message before starting new work"],
  both: ["Skip jobs that need a phone call", "Post at most two jobs a day", "Bid only on jobs you can finish within a day"],
};

// Whether an order names a dollar amount. Nothing enforces an order, so the console
// points at the limits. The page embeds this function's source, so it closes over nothing.
export function mentionsMoney(text: string): boolean {
  return /\$\d/.test(text);
}
