import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/core/tools.js";

// The tool table must offer exactly the values the server publishes. The spec is the
// copy taskfast-cli vendors and checks against the live server (its spec-drift gate):
// spec/openapi.yaml at tag taskfast-cli-v0.19.6, sha256 51c0bba22cff86dd9c06962064af583993852cfbb5873212262d37bc5b232a47.
// To refresh, copy that file from the newest CLI release and update the tag and hash here:
//   curl -fL -o test/fixtures/openapi.yaml https://raw.githubusercontent.com/Akuja-Inc/taskfast-cli/<tag>/spec/openapi.yaml
const OPENAPI = join(import.meta.dirname, "fixtures", "openapi.yaml");

// The flow-style enum on the first `enum:` line after `marker` in the YAML text.
function enumAfter(yaml: string, marker: RegExp): string[] {
  const at = yaml.search(marker);
  if (at < 0) throw new Error(`contract marker ${marker} not found`);
  const m = /\benum:\s*\[([^\]]*)\]/.exec(yaml.slice(at));
  if (!m) throw new Error(`no enum after ${marker}`);
  return m[1]!.split(",").map((v) => v.trim()).filter(Boolean);
}

describe("tools match the server contract", () => {
  const yaml = readFileSync(OPENAPI, "utf8");

  it("bid_list offers exactly the bid statuses BidDetail publishes", () => {
    const published = enumAfter(yaml, /\n {4}BidDetail:\n/);
    expect(published).toContain("accepted_pending_escrow");
    expect(TOOLS.bid_list!.schema.properties.status!.enum).toEqual(published);
  });

  it("and the bid list's status filter publishes the same set", () => {
    expect(enumAfter(yaml, /- name: status\n\s+in: query[\s\S]*?Filter by bid status/)).toEqual(enumAfter(yaml, /\n {4}BidDetail:\n/));
  });
});
