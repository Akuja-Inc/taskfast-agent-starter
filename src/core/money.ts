import type { CliResult } from "./cli.js";
import type { AmountSource } from "./tools.js";
import type { ActionRecord, Limits, Spend } from "./types.js";

// Money policy for the two money tools, as pure functions: where an amount comes from,
// whether it fits the agent's own limits, and today's spend (UTC).

export const today = (now = new Date()): string => now.toISOString().slice(0, 10);
export const spentToday = (spend: Spend, now = new Date()): number => (spend.day === today(now) ? spend.usd : 0);
export const addSpend = (spend: Spend, usd: number, now = new Date()): Spend => ({ day: today(now), usd: spentToday(spend, now) + usd });

// Why a money action of this amount would break the agent's own limits, or null.
// No limits set: nothing is checked.
export function overLimit(limits: Limits | undefined, spent: number, amount: number): string | null {
  if (limits?.perJobUsd !== undefined && amount > limits.perJobUsd) return `over your limit: $${amount} is more than your $${limits.perJobUsd} per job`;
  if (limits?.dailyUsd !== undefined && spent + amount > limits.dailyUsd) return `over your limit: $${spent} spent today plus $${amount} is more than your $${limits.dailyUsd} a day`;
  return null;
}

type Bid = { id?: unknown; agent_id?: unknown; price?: unknown };
type BidPage = { bids?: Bid[]; meta?: { has_more?: unknown; next_cursor?: unknown } } | null;

// Finds input.bid_id among the bids on input.task_id. It follows every page, so a bid
// past the first page is found, and it tells "not on the task" apart from "could not
// read". A string is the reason it was not found. `taskfast task bids` returns
// { task_id, bids: [...], meta } (the CLI renames the server's data key), and 100 is
// its page maximum.
export async function findBid(input: Record<string, unknown>, read: (args: string[]) => Promise<CliResult>): Promise<Bid | string> {
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = cursor ? [`--cursor=${cursor}`] : [];
    const r = await read(["task", "bids", "--limit=100", ...page, "--", String(input.task_id)]);
    if (r.outcome !== "ok") return `could not read the bids: ${r.error ?? r.outcome}`;
    const d = r.data as BidPage;
    const bid = Array.isArray(d?.bids) ? d.bids.find((b) => b.id === input.bid_id) : undefined;
    if (bid) return bid;
    const next = d?.meta?.has_more === true && typeof d.meta.next_cursor === "string" ? d.meta.next_cursor : null;
    if (!next) return `bid ${String(input.bid_id)} is not among the bids on task ${String(input.task_id)}`;
    if (seen.has(next)) return "could not read the bids: the bid list repeated a page";
    seen.add(next);
    cursor = next;
  }
}

// The amount a money tool commits, from code (I9): the bid's price as the server reports
// it, or the platform's submission fee. The bid read is deliberate, even if the model
// just listed the bids itself: the price must come from the server, never from the
// model. A string is the reason the amount could not be fixed.
export async function amountOf(source: "bidPrice" | "submissionFee" | undefined, input: Record<string, unknown>, read: (args: string[]) => Promise<CliResult>): Promise<number | string> {
  if (source === "submissionFee") return submissionFee(read);
  if (source !== "bidPrice") return "this money tool has no amount source";
  const bid = await findBid(input, read);
  if (typeof bid === "string") return bid;
  const price = Number(bid.price);
  return Number.isFinite(price) && price > 0 ? price : `bid ${String(input.bid_id)} has no usable price (${JSON.stringify(bid.price)})`;
}

// The fee a post is charged, as the server publishes it (`taskfast platform config`
// prints it at data.config.submission_fee). The server documents reading it before
// posting, to budget for it.
async function submissionFee(read: (args: string[]) => Promise<CliResult>): Promise<number | string> {
  const r = await read(["platform", "config"]);
  if (r.outcome !== "ok") return `could not read the submission fee: ${r.error ?? r.outcome}`;
  const fee = Number((r.data as { config?: { submission_fee?: unknown } } | null)?.config?.submission_fee);
  return Number.isFinite(fee) && fee >= 0 ? fee : "could not read the submission fee: the platform config has none";
}

// Pure money helpers retained for package consumers. The Pi adapter uses amountOf
// and overLimit inside its session-level reservation/accounting protocol.

// Fixes the amount from the server and checks it against the agent's own limits.
export async function authorize(source: AmountSource, input: Record<string, unknown>, limits: Limits | undefined, spend: Spend, read: (args: string[]) => Promise<CliResult>): Promise<{ amount: number } | { refused: string }> {
  const amount = await amountOf(source, input, read);
  if (typeof amount === "string") return { refused: amount };
  const over = overLimit(limits, spentToday(spend), amount);
  return over ? { refused: over } : { amount };
}

// Checks the amount fixed at arm time again, against today's spend now. A money action
// with no fixed amount is refused rather than checked as a guess.
export function recheck(amount: number | undefined, limits: Limits | undefined, spend: Spend): string | null {
  if (amount === undefined) return "no amount was fixed for this money action";
  return overLimit(limits, spentToday(spend), amount);
}

// The spend after a money action ended with this status. Money that may have moved
// counts, the conservative side, as the treasury does: done and uncertain are counted,
// only a refusal (failed) is not.
export function account(spend: Spend, amount: number, status: ActionRecord["status"], now = new Date()): Spend {
  return status === "failed" ? spend : addSpend(spend, amount, now);
}
