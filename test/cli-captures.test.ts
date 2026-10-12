import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CliResult } from "../src/core/cli.js";
import { counterpartyRefusal } from "../src/core/counterparty.js";
import { amountOf } from "../src/core/money.js";

// The money and counterparty parsers against what the real taskfast 0.19.0 binary prints (see
// test/fixtures/cli/README.md), not against output this package invented.
const capture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "cli", `${name}.json`), "utf8")) as { ok: boolean; data: unknown };
const asRead = (name: string) => async (): Promise<CliResult> => ({ outcome: "ok", data: capture(name).data as never });

describe("parsers against captured CLI output", () => {
  it("finds a bid's price in real `taskfast task bids` output (data.bids, not data.data)", async () => {
    const c = capture("task-bids") as { data: { bids: { id: string; task_id: string; price: string }[] } };
    const bid = c.data.bids[0]!;
    expect(await amountOf("bidPrice", { task_id: bid.task_id, bid_id: bid.id }, asRead("task-bids"))).toBe(Number(bid.price));
  });

  it("reads the submission fee from real `taskfast platform config` output", async () => {
    const c = capture("platform-config") as { data: { config: { submission_fee: string } } };
    expect(await amountOf("submissionFee", {}, asRead("platform-config"))).toBe(Number(c.data.config.submission_fee));
  });

  it("finds a task's poster and worker in real `taskfast task get` output (data.task)", async () => {
    const t = (capture("task-get") as { data: { task: { id: string; poster_id: string; worker_agent_id: string } } }).data.task;
    const me = "00000000-0000-4000-8000-000000000001";
    const input = { task_id: t.id };
    const read = asRead("task-get");
    expect(await counterpartyRefusal("poster", input, { me, accounts: [t.poster_id], agents: [] }, read)).toBeNull();
    expect(await counterpartyRefusal("worker", input, { me, accounts: [], agents: [t.worker_agent_id] }, read)).toBeNull();
    expect(await counterpartyRefusal("poster", input, { me, accounts: [], agents: [t.worker_agent_id] }, read)).toMatch(/do not deal/);
  });

  it("finds a bid's bidder in real `taskfast task bids` output", async () => {
    const b = (capture("task-bids") as { data: { bids: { id: string; task_id: string; agent_id: string }[] } }).data.bids[0]!;
    const c = { me: "00000000-0000-4000-8000-000000000001", accounts: [], agents: [b.agent_id] };
    expect(await counterpartyRefusal("bidder", { task_id: b.task_id, bid_id: b.id }, c, asRead("task-bids"))).toBeNull();
  });
});
