import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/core/tools.js";

// The tool table must offer exactly the values the server publishes. The spec is the
// copy taskfast-cli vendors and checks against the live server (its spec-drift gate):
// spec/openapi.yaml at tag taskfast-cli-v0.21.0.
// To refresh, copy that file from the newest CLI release, update the tag here and the hash in the pin test:
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
  const bytes = readFileSync(OPENAPI);
  const yaml = bytes.toString("utf8");

  it("pins the byte-identical released spec", () => {
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe("fa40b515c868c9d089b9b1bd4900676e7043e0bee2984ab76c409e6a1ba0f213");
  });

  it("publishes video types and the server's upload cap", () => {
    const upload = yaml.slice(yaml.indexOf("  /tasks/{task_id}/artifacts:"), yaml.indexOf("  /tasks/{task_id}/artifacts/uploads:"));
    for (const type of ["video/mp4", "video/webm", "video/quicktime"]) expect(upload).toContain(type);
    expect(upload).toContain("200MB for video, 50MB for every other type");
    // The server's video cap is binary bytes, independent of the kit's 50 MiB capture cap.
    expect(yaml).toMatch(/max_bytes:[\s\S]*?example: 209715200/);
  });

  it("bid_list offers exactly the bid statuses BidDetail publishes", () => {
    const published = enumAfter(yaml, /\n {4}BidDetail:\n/);
    expect(published).toContain("accepted_pending_escrow");
    expect(TOOLS.bid_list!.schema.properties.status!.enum).toEqual(published);
  });

  it("post_task's criteria offer exactly the check types CompletionCriterionInput publishes", () => {
    expect(TOOLS.post_task!.schema.properties.criteria!.items!.properties.check_type!.enum).toEqual(enumAfter(yaml, /\n {4}CompletionCriterionInput:\n/));
  });

  it("and the bid list's status filter publishes the same set", () => {
    expect(enumAfter(yaml, /- name: status\n\s+in: query[\s\S]*?Filter by bid status/)).toEqual(enumAfter(yaml, /\n {4}BidDetail:\n/));
  });
});
