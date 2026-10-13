import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CliResult } from "../src/core/cli.js";
import { amountOf } from "../src/core/money.js";

// The money parsers against what the real taskfast 0.19.0 binary prints (see
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
});
