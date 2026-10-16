import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CliResult } from "../src/core/cli.js";
import { amountOf } from "../src/core/money.js";

// The money parsers against what the real taskfast binary prints (see
// test/fixtures/cli/README.md), not against output this package invented: 0.19.0 for the
// bid list and platform config, 0.19.7 for the gh70 bond captures.
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

  it("reads a bond's stake from real `taskfast bond post --dry-run` and its token decimals from `cast call`", async () => {
    const dry = capture("gh70/bond-dry-run") as { data: { action: string; amount: number; token: string } };
    const decimals = capture("gh70/cast-decimals") as { data: { decoded: string[] } };
    const read = async (args: string[]): Promise<CliResult> => ({ outcome: "ok", data: (args[0] === "bond" ? dry.data : decimals.data) as never });
    expect(dry.data.action).toBe("would_post_bond");
    expect(decimals.data.decoded[0]).toBe("6");
    expect(await amountOf("bondStake", { task_id: "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b" }, read)).toBe(2.5);
  });
});
