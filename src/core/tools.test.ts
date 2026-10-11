import { describe, expect, it } from "vitest";
import { prepare, TOOLS } from "./tools.js";

const T = "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b";

describe("prepare", () => {
  it("builds each command with options as --name=value and positionals after --", () => {
    expect(prepare("task_get", { task_id: T }).args).toEqual(["task", "get", "--", T]);
    expect(prepare("bid_create", { task_id: T, price: "40.00", pitch: "I do this daily" }).args).toEqual(["bid", "create", "--price=40.00", "--pitch=I do this daily", "--", T]);
    expect(prepare("task_submit", { task_id: T, summary: "Done: 12 pages" }).args).toEqual(["task", "submit", "--summary=Done: 12 pages", "--", T]);
    expect(prepare("message_send", { task_id: T, content: "Two questions" }).args).toEqual(["message", "send", "--content=Two questions", "--", T]);
    expect(prepare("discover", { capability: "writing", budget_max: "50", limit: 10 }).args).toEqual(["discover", "--capability=writing", "--budget-max=50", "--limit=10"]);
    expect(prepare("wallet_balance", {}).args).toEqual(["wallet", "balance"]);
  });

  it("keeps a value that looks like a flag inside its own option", () => {
    const { args } = prepare("message_send", { task_id: T, content: "--env prod" });
    expect(args).toContain("--content=--env prod");
    expect(args.filter((a) => a === "--env" || a === "prod")).toEqual([]);
  });

  it.each([
    ["a task id that is a flag", "task_get", { task_id: "--env=prod" }, /task_id must be a UUID/],
    ["a task id that is not a UUID", "task_claim", { task_id: "t-1" }, /task_id must be a UUID/],
    ["a price with letters", "bid_create", { task_id: T, price: "40 USD" }, /decimal amount/],
    ["a limit over 100", "discover", { limit: 500 }, /1 to 100/],
    ["a status with spaces", "task_list", { status: "in progress" }, /single word/],
    ["an empty summary", "task_submit", { task_id: T, summary: "  " }, /non-empty text/],
    ["an unknown field", "task_get", { task_id: T, env: "prod" }, /has no field env/],
    ["an unknown tool", "withdraw_all", {}, /no tool named withdraw_all/],
    ["a non-object input", "task_get", [T], /must be an object/],
    ["an inherited tool name", "toString", {}, /no tool named toString/],
  ])("refuses %s", (_n, tool, input, why) => {
    expect(() => prepare(tool, input)).toThrow(why);
  });

  it("passes a bid status filter through (the values are checked against the contract in test/tools-contract.test.ts)", () => {
    expect(prepare("bid_list", { status: "accepted_pending_escrow" }).args).toEqual(["bid", "list", "--status=accepted_pending_escrow"]);
  });

  it("keys each write so it can run once: per task, or per task and message text", () => {
    expect(prepare("bid_create", { task_id: T, price: "40.00" }).key).toBe(`bid:${T}`);
    expect(prepare("bid_create", { task_id: T, price: "55.00" }).key).toBe(`bid:${T}`);
    expect(prepare("task_claim", { task_id: T }).key).toBe(`claim:${T}`);
    expect(prepare("task_submit", { task_id: T, summary: "a" }).key).toBe(`submit:${T}`);
    const m1 = prepare("message_send", { task_id: T, content: "hello" }).key;
    expect(m1).toMatch(new RegExp(`^message:${T}:[0-9a-f]{16}$`));
    expect(prepare("message_send", { task_id: T, content: "hello" }).key).toBe(m1);
    expect(prepare("message_send", { task_id: T, content: "hello again" }).key).not.toBe(m1);
    expect(prepare("task_get", { task_id: T }).key).toBeNull();
  });

  it("marks exactly the two tools that commit funds as money, each with a code-side amount source", () => {
    const money = Object.entries(TOOLS).filter(([, t]) => t.kind === "money");
    expect(money.map(([n, t]) => [n, t.amount])).toEqual([["post_task", "submissionFee"], ["escrow_sign", "bidPrice"]]);
    expect(Object.values(TOOLS).filter((t) => t.kind !== "money").every((t) => t.amount === undefined)).toBe(true);
    // The model cannot hand escrow a price: the tool has no such field.
    expect(Object.keys(TOOLS.escrow_sign!.schema.properties)).toEqual(["task_id", "bid_id"]);
  });

  it("names the other side of every write except a post, which has none yet (containment)", () => {
    const writes = Object.entries(TOOLS).filter(([, t]) => t.kind === "write" || t.kind === "money");
    expect(Object.fromEntries(writes.map(([n, t]) => [n, t.party]))).toEqual({
      bid_create: "poster", task_claim: "poster", task_submit: "poster", message_send: "other",
      post_task: null, bid_accept: "bidder", bid_reject: "bidder", escrow_sign: "bidder",
      task_approve: "worker", task_dispute: "worker", settle: "worker",
    });
    expect(Object.values(TOOLS).filter((t) => t.kind === "read" || t.kind === "memory").every((t) => t.party === undefined)).toBe(true);
    // The bidder is found among the task's bids, so every bidder tool takes the task.
    for (const [n, t] of writes) if (t.party === "bidder") expect(TOOLS[n]!.schema.required).toEqual(["task_id", "bid_id"]);
  });

  it("builds the poster commands", () => {
    const B = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    expect(prepare("post_task", { title: "Logo", description: "A logo for a bakery", budget: "40.00", pickup_deadline_hours: 24 }).args).toEqual(["post", "--title=Logo", "--description=A logo for a bakery", "--budget=40.00", "--pickup-deadline-hours=24", "--yes"]);
    expect(prepare("escrow_sign", { task_id: T, bid_id: B }).args).toEqual(["escrow", "sign", "--", B]);
    expect(prepare("escrow_sign", { task_id: T, bid_id: B }).key).toBe(`escrow:${B}`);
    expect(prepare("bid_accept", { bid_id: B }).args).toEqual(["bid", "accept", "--", B]);
    expect(prepare("bid_reject", { bid_id: B, reason: "out of budget" }).args).toEqual(["bid", "reject", "--reason=out of budget", "--", B]);
    expect(prepare("task_approve", { task_id: T }).args).toEqual(["task", "approve", "--", T]);
    expect(prepare("task_dispute", { task_id: T, reason: "missing pages" }).args).toEqual(["task", "dispute", "--reason=missing pages", "--", T]);
    expect(prepare("settle", { task_id: T }).args).toEqual(["settle", "--yes", "--", T]);
    expect(prepare("task_bids", { task_id: T }).args).toEqual(["task", "bids", "--", T]);
  });

  it.each([
    ["a budget with letters", { title: "x", description: "y", budget: "lots", pickup_deadline_hours: 24 }, /decimal amount/],
    ["a pickup window the server does not offer", { title: "x", description: "y", budget: "10.00", pickup_deadline_hours: 48 }, /one of 1, 4, 12, 24, 72/],
    ["an empty title", { title: " ", description: "y", budget: "10.00", pickup_deadline_hours: 24 }, /title must be non-empty/],
  ])("refuses a post with %s", (_n, input, why) => {
    expect(() => prepare("post_task", input)).toThrow(why);
  });

  it("names the right id in a bad bid id error", () => {
    expect(() => prepare("bid_accept", { bid_id: "--env=prod" })).toThrow(/bid_id must be a UUID/);
  });
});
