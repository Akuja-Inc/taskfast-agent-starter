import { describe, expect, it } from "vitest";
import type { CliResult, Outcome } from "./cli.js";
import { amountOf, overLimit, recheck, reserve, settle, today, type Ledger } from "./money.js";
import type { Limits } from "./types.js";

const T = "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b";
const B = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const NOON = new Date("2026-10-10T12:00:00Z");
// The UTC rollover boundary: reserved just before midnight, dispatched just after.
const EVE = new Date("2026-10-10T23:59:59Z");
const NEXT = new Date("2026-10-11T00:00:00Z");

describe("overLimit", () => {
  it("checks nothing without limits", () => {
    expect(overLimit(undefined, 1e6, 1e6)).toBeNull();
    expect(overLimit({}, 1e6, 1e6)).toBeNull();
  });

  it("refuses over the per-job limit, and over the day once today's spend is counted", () => {
    expect(overLimit({ perJobUsd: 30 }, 0, 30)).toBeNull();
    expect(overLimit({ perJobUsd: 30 }, 0, 30.01)).toMatch(/\$30.01 is more than your \$30 per job/);
    expect(overLimit({ dailyUsd: 50 }, 30, 20)).toBeNull();
    expect(overLimit({ dailyUsd: 50 }, 30, 25)).toMatch(/\$30 spent today plus \$25 is more than your \$50 a day/);
  });
});

describe("reserve", () => {
  const AT = "2026-10-10T12:00:00.000Z";
  const reserveBid = (l: Ledger, key: string, amount: number, limits?: Limits) => reserve(l, key, { amount, limits, day: "2026-10-10", at: AT });

  it("commits the spend at reservation, with and without limits", () => {
    const noLimits: Ledger = { actions: {}, spend: {} };
    expect(reserveBid(noLimits, "bid:b1", 5)).toBeNull();
    expect(noLimits.actions["bid:b1"]).toEqual({ status: "reserved", at: AT, amount: 5, day: "2026-10-10" });
    expect(noLimits.spend).toEqual({ "2026-10-10": 5 });
    const limited: Ledger = { actions: {}, spend: {} };
    expect(reserveBid(limited, "bid:b1", 5, { dailyUsd: 50 })).toBeNull();
    expect(limited.spend).toEqual({ "2026-10-10": 5 });
  });

  it("a daily limit counts prior reservations", () => {
    const l: Ledger = { actions: {}, spend: {} };
    expect(reserveBid(l, "bid:b1", 30, { dailyUsd: 50 })).toBeNull();
    expect(reserveBid(l, "bid:b2", 25, { dailyUsd: 50 })).toMatch(/\$30 spent today plus \$25 is more than your \$50 a day/);
    expect(l.spend["2026-10-10"]).toBe(30);
    expect(l.actions["bid:b2"]).toBeUndefined();
  });
});

describe("recheck", () => {
  // One stake reserved just before midnight, dispatched just after.
  const reservedBeforeMidnight = (): Ledger => {
    const l: Ledger = { actions: {}, spend: {} };
    expect(today(EVE)).toBe("2026-10-10");
    expect(today(NEXT)).toBe("2026-10-11");
    reserve(l, "stake:t1", { amount: 40, limits: undefined, day: today(EVE), at: EVE.toISOString() });
    return l;
  };

  it("moves the spend to the new day at the UTC rollover boundary", () => {
    const l = reservedBeforeMidnight();
    expect(recheck(l, "stake:t1", { limits: undefined, day: today(NEXT) })).toBeNull();
    expect(l.actions["stake:t1"]!.day).toBe("2026-10-11");
    expect(l.spend).toEqual({ "2026-10-10": 0, "2026-10-11": 40 });
  });

  it("the new day's limit can refuse, releasing the spend and failing the action", () => {
    const l = reservedBeforeMidnight();
    reserve(l, "stake:t2", { amount: 30, limits: { dailyUsd: 50 }, day: today(NEXT), at: NEXT.toISOString() });
    expect(recheck(l, "stake:t1", { limits: { dailyUsd: 50 }, day: today(NEXT) })).toMatch(/\$30 spent today plus \$40 is more than your \$50 a day/);
    expect(l.actions["stake:t1"]!.status).toBe("failed");
    expect(l.spend).toEqual({ "2026-10-10": 0, "2026-10-11": 30 });
  });

  it("excludes its own reservation while testing the daily limit", () => {
    const l: Ledger = {
      actions: { "bid:b1": { status: "reserved", at: NOON.toISOString(), amount: 40, day: "2026-10-10" } },
      spend: { "2026-10-10": 40 },
    };
    expect(recheck(l, "bid:b1", { limits: { dailyUsd: 50 }, day: "2026-10-10" })).toBeNull();
    expect(l.spend["2026-10-10"]).toBe(40);
  });
});

describe("settle", () => {
  const settled = (outcome: Outcome): Ledger => {
    const l: Ledger = { actions: {}, spend: {} };
    reserve(l, "bid:b1", { amount: 5, limits: undefined, day: "2026-10-10", at: NOON.toISOString() });
    settle(l, "bid:b1", outcome, "2026-10-10T12:00:01.000Z");
    return l;
  };

  it("releases spend only on failed; done and uncertain stay counted", () => {
    const done = settled("ok");
    expect(done.actions["bid:b1"]!.status).toBe("done");
    expect(done.spend["2026-10-10"]).toBe(5);
    const uncertain = settled("uncertain");
    expect(uncertain.actions["bid:b1"]!.status).toBe("uncertain");
    expect(uncertain.spend["2026-10-10"]).toBe(5);
    const failed = settled("failed");
    expect(failed.actions["bid:b1"]!.status).toBe("failed");
    expect(failed.spend["2026-10-10"]).toBe(0);
  });
});

it("daily records are never evicted", () => {
  const l: Ledger = { actions: {}, spend: {} };
  reserve(l, "bid:b1", { amount: 5, limits: undefined, day: "2026-10-09", at: "2026-10-09T12:00:00.000Z" });
  reserve(l, "bid:b2", { amount: 6, limits: undefined, day: "2026-10-10", at: NOON.toISOString() });
  settle(l, "bid:b2", "failed", NOON.toISOString());
  recheck(l, "bid:b1", { limits: undefined, day: "2026-10-10" });
  // The released and moved days keep their records; a released day stays at 0.
  expect(Object.keys(l.spend).sort()).toEqual(["2026-10-09", "2026-10-10"]);
  expect(l.spend).toEqual({ "2026-10-09": 0, "2026-10-10": 5 });
});

describe("amountOf", () => {
  // A fake `task bids` that serves the given pages in order and records each call.
  function pages(...ps: CliResult[]) {
    const calls: string[][] = [];
    const read = async (args: string[]) => {
      calls.push(args);
      return ps[calls.length - 1] ?? { outcome: "uncertain" as const, error: "no more pages in fake" };
    };
    return { read, calls };
  }
  const page = (bids: object[], next?: string): CliResult => ({ outcome: "ok", data: { task_id: T, bids: bids as never, meta: next ? { has_more: true, next_cursor: next } : { has_more: false } } });

  it("reads escrow's amount from the server's bid list", async () => {
    const f = pages(page([{ id: "other", price: "99.00" }, { id: B, price: "18.50" }]));
    expect(await amountOf("bidPrice", { task_id: T, bid_id: B }, f.read)).toBe(18.5);
    expect(f.calls).toEqual([["task", "bids", "--limit=100", "--", T]]);
  });

  it("follows every page, so a bid past the first page is found", async () => {
    const f = pages(page([{ id: "a", price: "1.00" }], "c2"), page([{ id: "b", price: "2.00" }], "c3"), page([{ id: B, price: "7.25" }]));
    expect(await amountOf("bidPrice", { task_id: T, bid_id: B }, f.read)).toBe(7.25);
    expect(f.calls.map((c) => c.find((a) => a.startsWith("--cursor=")) ?? "")).toEqual(["", "--cursor=c2", "--cursor=c3"]);
  });

  it.each([
    ["the bid is on no page", pages(page([{ id: "a", price: "1.00" }], "c2"), page([])), /is not among the bids on task/],
    ["the bid has no usable price", pages(page([{ id: B, price: "free" }])), /has no usable price/],
    ["the list has an unknown shape", pages({ outcome: "ok", data: [{ id: B, price: "18.50" }] }), /is not among the bids/],
    ["a page read fails", pages(page([], "c2"), { outcome: "uncertain", error: "network: reset" }), /could not read the bids: network: reset/],
    ["the list repeats a page", pages(page([], "c2"), page([], "c2")), /repeated a page/],
  ] as const)("gives a reason, not an amount, when %s", async (_n, f, why) => {
    expect(await amountOf("bidPrice", { task_id: T, bid_id: B }, f.read)).toMatch(why);
  });

  it("reads a post's cost from the platform's submission fee, not its budget", async () => {
    const f = pages({ outcome: "ok", data: { config: { submission_fee: "0.25" } } });
    expect(await amountOf("submissionFee", { budget: "40.00" }, f.read)).toBe(0.25);
    expect(f.calls).toEqual([["platform", "config"]]);
  });

  it.each([
    ["the read fails", { outcome: "uncertain", error: "network: reset" }, /could not read the submission fee: network: reset/],
    ["the config has no fee", { outcome: "ok", data: { config: {} } }, /has none/],
  ] as const)("gives a reason, not a fee, when %s", async (_n, r, why) => {
    expect(await amountOf("submissionFee", {}, pages(r as CliResult).read)).toMatch(why);
  });

  it("refuses a money tool with no amount source", async () => {
    expect(await amountOf(undefined, {}, pages().read)).toMatch(/no amount source/);
  });

  const DRY: CliResult = { outcome: "ok", data: { action: "would_post_bond", amount: 2500000, token: "0x20c0000000000000000000000000000000000000" } };
  const DECIMALS: CliResult = { outcome: "ok", data: { decoded: ["6"] } };
  // A fake `bond post --dry-run` and `cast call` pair; bondStake uses both reads.
  function bondRead(dry: CliResult = DRY, decimals: CliResult = DECIMALS) {
    const calls: string[][] = [];
    const read = async (args: string[]) => { calls.push(args); return args[0] === "bond" ? dry : decimals; };
    return { read, calls };
  }

  it("reads a bond's stake from the quote its dry run fetches, scaled by the token's decimals", async () => {
    const f = bondRead();
    expect(await amountOf("bondStake", { task_id: T }, f.read)).toBe(2.5);
    expect(f.calls).toEqual([
      ["bond", "post", "--dry-run", "--", T],
      ["cast", "call", "0x20c0000000000000000000000000000000000000", "decimals()(uint8)"],
    ]);
  });

  it.each([
    ["the dry run fails", { outcome: "uncertain", error: "network: reset" } as CliResult, DECIMALS, /could not read the bond quote: network: reset/],
    ["the dry run did not quote a stake", { outcome: "ok", data: { amount: 2500000 } } as CliResult, DECIMALS, /did not quote a stake/],
    ["the quote has no usable amount", { outcome: "ok", data: { action: "would_post_bond", token: "0x20c0000000000000000000000000000000000000" } } as CliResult, DECIMALS, /no usable amount/],
    ["the quote amount is not a whole number", { outcome: "ok", data: { action: "would_post_bond", amount: 2500000.5, token: "0x20c0000000000000000000000000000000000000" } } as CliResult, DECIMALS, /no usable amount/],
    ["the quote has no usable token", { outcome: "ok", data: { action: "would_post_bond", amount: 2500000, token: "0x20c0" } } as CliResult, DECIMALS, /no usable token/],
    ["the decimals read fails", DRY, { outcome: "uncertain", error: "rpc: unavailable" } as CliResult, /could not read the bond token decimals: rpc: unavailable/],
    ["the decimals read is empty", DRY, { outcome: "ok", data: { decoded: [] } } as CliResult, /decimals are not usable/],
    ["the decimals are out of range", DRY, { outcome: "ok", data: { decoded: ["99"] } } as CliResult, /decimals are not usable/],
  ] as const)("gives a reason, not an amount, when %s", async (_n, dry, decimals, why) => {
    expect(await amountOf("bondStake", { task_id: T }, bondRead(dry, decimals).read)).toMatch(why);
  });
});


