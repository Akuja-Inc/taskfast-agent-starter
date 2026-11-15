import type { CliResult, Outcome } from "./cli.js";
import type { AmountSource } from "./tools.js";
import type { Limits } from "./types.js";

// Money policy as pure functions: where an amount comes from, whether it fits the
// agent's own limits, and the ledger transitions policy.ts drives around each
// dispatch. The transitions have no I/O and no clock reads: callers pass the day
// and the time, so tests drive them directly.

export const today = (now = new Date()): string => now.toISOString().slice(0, 10);

// Why a money action of this amount would break the agent's own limits, or null.
// No limits set: nothing is checked.
export function overLimit(limits: Limits | undefined, spent: number, amount: number): string | null {
  if (limits?.perJobUsd !== undefined && amount > limits.perJobUsd) return `over your limit: $${amount} is more than your $${limits.perJobUsd} per job`;
  if (limits?.dailyUsd !== undefined && spent + amount > limits.dailyUsd) return `over your limit: $${spent} spent today plus $${amount} is more than your $${limits.dailyUsd} a day`;
  return null;
}

// One reserved or settled marketplace action, and the ledger of actions and spend
// by UTC day. Spend is committed at reservation; entries and daily records are
// never evicted (known refusals release the amount, uncertain keeps it counted).
export type Action = {
  status: "reserved" | "done" | "failed" | "uncertain";
  at: string;
  amount: number;
  day: string;
};
export type Ledger = {
  actions: Record<string, Action>;
  spend: Record<string, number>;
};

// Commits one action's funds in the same step as its reservation: writes the
// `reserved` action and adds to the day's spend, or returns why it is refused.
export function reserve(ledger: Ledger, key: string, move: { amount: number; limits: Limits | undefined; day: string; at: string }): string | null {
  const over = overLimit(move.limits, ledger.spend[move.day] ?? 0, move.amount);
  if (over) return over;
  ledger.actions[key] = { status: "reserved", at: move.at, amount: move.amount, day: move.day };
  ledger.spend[move.day] = (ledger.spend[move.day] ?? 0) + move.amount;
  return null;
}

// Checks the amount fixed at reservation again right before dispatch, against the
// spend of the day now, excluding this action's own reservation. The UTC day may
// have rolled over since: the amount moves to the new day. A refusal releases the
// reserved spend and marks the action failed, so only a refusal can be retried.
export function recheck(ledger: Ledger, key: string, check: { limits: Limits | undefined; day: string }): string | null {
  const action = ledger.actions[key];
  const other = (ledger.spend[check.day] ?? 0) - (action.day === check.day ? action.amount : 0);
  const refused = overLimit(check.limits, other, action.amount);
  if (refused) {
    ledger.spend[action.day] -= action.amount;
    action.status = "failed";
    return refused;
  }
  if (action.day !== check.day) {
    ledger.spend[action.day] -= action.amount;
    ledger.spend[check.day] = (ledger.spend[check.day] ?? 0) + action.amount;
    action.day = check.day;
  }
  return null;
}

// Records the dispatch outcome. `ok` settles as `done`; spend is released only for
// a known refusal (`failed`), because money that may have moved stays counted.
export function settle(ledger: Ledger, key: string, outcome: Outcome, at: string): void {
  const action = ledger.actions[key];
  action.status = outcome === "ok" ? "done" : outcome;
  action.at = at;
  if (outcome === "failed") ledger.spend[action.day] -= action.amount;
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
// it, the platform's submission fee, or a task's quoted bond or stake. The bid read is deliberate,
// even if the model just listed the bids itself: the amount must come from the server,
// never from the model. A string is the reason the amount could not be fixed.
export async function amountOf(source: AmountSource | undefined, input: Record<string, unknown>, read: (args: string[]) => Promise<CliResult>): Promise<number | string> {
  const price = await priceOf(source, input, read);
  return typeof price === "string" ? price : price.usd;
}

// What a money tool commits, fixed by code: the amount in USD for the agent's limits,
// and the options its command needs to commit exactly that amount. `taskfast stake`
// takes the stake as --amount in bond base units, so the quote that is counted is the
// stake that is sent; every other money command fixes its own amount.
export interface Price { usd: number; flags: string[] }
export async function priceOf(source: AmountSource | undefined, input: Record<string, unknown>, read: (args: string[]) => Promise<CliResult>): Promise<Price | string> {
  if (source === "bondStake" || source === "stakeQuote") {
    const quote = await bondQuote(input, read);
    if (typeof quote === "string") return quote;
    return { usd: quote.usd, flags: source === "stakeQuote" ? [`--amount=${quote.units}`] : [] };
  }
  const usd = await serverAmount(source, input, read);
  return typeof usd === "string" ? usd : { usd, flags: [] };
}

async function serverAmount(source: AmountSource | undefined, input: Record<string, unknown>, read: (args: string[]) => Promise<CliResult>): Promise<number | string> {
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

// The performance bond or stake a task requires (the server's /stake/quote), in bond
// base units and in USD for the agent's limits. `taskfast bond post --dry-run` fetches
// that quote and stops before any transaction, so `data.amount` is the required stake
// in base units. The token's decimals come from a read-only `cast call`, so nothing is
// assumed about the token. A string is the reason the amount could not be fixed.
async function bondQuote(input: Record<string, unknown>, read: (args: string[]) => Promise<CliResult>): Promise<{ usd: number; units: number } | string> {
  const r = await read(["bond", "post", "--dry-run", "--", String(input.task_id)]);
  if (r.outcome !== "ok") return `could not read the bond quote: ${r.error ?? r.outcome}`;
  const data = r.data as { action?: unknown; amount?: unknown; token?: unknown } | null;
  if (data?.action !== "would_post_bond") return "the bond dry run did not quote a stake";
  const raw = data.amount;
  if (!Number.isSafeInteger(raw) || (raw as number) <= 0) return `the bond quote has no usable amount (${JSON.stringify(raw)})`;
  const token = data.token;
  if (typeof token !== "string" || !/^0x[0-9a-f]{40}$/i.test(token)) return `the bond quote has no usable token (${JSON.stringify(token)})`;
  const decimals = await tokenDecimals(token, read);
  if (typeof decimals === "string") return decimals;
  return { usd: (raw as number) / 10 ** decimals, units: raw as number };
}

// The bond token's decimals, as the token itself reports them. A string is the reason.
async function tokenDecimals(token: string, read: (args: string[]) => Promise<CliResult>): Promise<number | string> {
  const r = await read(["cast", "call", token, "decimals()(uint8)"]);
  if (r.outcome !== "ok") return `could not read the bond token decimals: ${r.error ?? r.outcome}`;
  const decoded = (r.data as { decoded?: unknown } | null)?.decoded;
  const decimals = Array.isArray(decoded) ? Number(decoded[0]) : NaN;
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : `the bond token decimals are not usable (${JSON.stringify(decoded)})`;
}
