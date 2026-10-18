import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CliResult } from "../src/core/cli.js";
import { amountOf } from "../src/core/money.js";
import { ownUploads } from "../src/core/tools.js";

// The money parsers against what the real taskfast binary prints (see
// test/fixtures/cli/README.md), not against output this package invented: 0.19.0 for the
// bid list and platform config, 0.19.7 for the gh70 bond captures, 0.20.1 for the gh71 artifact captures.
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

  it("finds this agent's uploads in real `taskfast artifact list` output", () => {
    expect(ownUploads(capture("gh71/artifact-list").data, "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d")).toEqual(["550e8400-e29b-41d4-a716-446655440001"]);
    // A task with no uploads still prints the list, so a first submit is not refused.
    expect(ownUploads(capture("gh71/artifact-list-empty").data, "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d")).toEqual([]);
  });

  it("shows why a refused submit cannot mean nothing was uploaded", () => {
    // The first file landed before the second was refused, yet the code is a refusal.
    const refused = capture("gh71/submit-second-upload-refused") as unknown as { error: { code: string } };
    expect(refused.error.code).toBe("validation");
    expect(readFileSync(join(import.meta.dirname, "fixtures", "cli", "gh71", "submit-second-upload-refused.requests.log"), "utf8")).toContain('"filename": "results.json"');
  });
});
