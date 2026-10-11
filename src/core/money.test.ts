import { describe, expect, it } from "vitest";
import type { CliResult } from "./cli.js";
import { account, addSpend, amountOf, authorize, overLimit, recheck, spentToday, today } from "./money.js";

const T = "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b";
const B = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const NOON = new Date("2026-10-10T12:00:00Z");

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

describe("spend by UTC day", () => {
  it("adds to today's spend and starts a new day at zero", () => {
    expect(today(NOON)).toBe("2026-10-10");
    expect(addSpend({ day: "2026-10-10", usd: 10 }, 5, NOON)).toEqual({ day: "2026-10-10", usd: 15 });
    expect(addSpend({ day: "2026-10-09", usd: 999 }, 5, NOON)).toEqual({ day: "2026-10-10", usd: 5 });
    expect(spentToday({ day: "2026-10-09", usd: 999 }, NOON)).toBe(0);
  });
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
});

describe("the money rule", () => {
  const S = { day: "2026-10-10", usd: 20 };
  const read = async (): Promise<CliResult> => ({ outcome: "ok", data: { config: { submission_fee: "0.25" } } });

  it("authorize fixes the amount from the server and applies the limits", async () => {
    expect(await authorize("submissionFee", {}, undefined, S, read)).toEqual({ amount: 0.25 });
    expect(await authorize("submissionFee", {}, { perJobUsd: 0.1 }, S, read)).toEqual({ refused: expect.stringMatching(/per job/) });
  });

  it("recheck refuses a money action with no fixed amount", () => {
    expect(recheck(undefined, undefined, S)).toMatch(/no amount was fixed/);
    expect(recheck(5, { dailyUsd: 50 }, S)).toBeNull();
  });

  it("account counts done and uncertain, never failed", () => {
    expect(account(S, 5, "done", NOON).usd).toBe(25);
    expect(account(S, 5, "uncertain", NOON).usd).toBe(25);
    expect(account(S, 5, "failed", NOON)).toBe(S);
  });
});

