import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXCLUDED, parityProblems, parseSurface } from "./cli-parity.js";
import { UNSUPPORTED_COMMANDS } from "./skills.js";
import { TOOLS, type ToolSpec } from "./tools.js";

const capture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "test", "fixtures", "cli", "surface.json"), "utf8")) as { version: string; help: Record<string, string> };
const surface = parseSurface(capture.help);

// The three entries' schemas and flags as they stood before gh#91 (values passed through
// as given): each advertised a value the CLI's argument parser refuses.
const word = (v: unknown) => String(v);
const opt = (name: string, v: unknown) => (v === undefined ? [] : [`--${name}=${word(v)}`]);
const s = (description: string) => ({ type: "string", description });
const BEFORE: Record<string, ToolSpec> = {
  ...TOOLS,
  discover: { ...TOOLS.discover!, schema: { ...TOOLS.discover!.schema, properties: { ...TOOLS.discover!.schema.properties, status: s("task status filter") } }, args: (i) => ["discover", ...opt("status", i.status), ...opt("capability", i.capability), ...opt("budget-min", i.budget_min), ...opt("budget-max", i.budget_max), ...opt("limit", i.limit)] },
  task_list: { ...TOOLS.task_list!, schema: { ...TOOLS.task_list!.schema, properties: { kind: s("which collection, e.g. mine or assigned"), status: s("status filter"), limit: { type: "number", description: "1-100" } } }, args: (i) => ["task", "list", ...opt("kind", i.kind), ...opt("status", i.status), ...opt("limit", i.limit)] },
  bid_list: { kind: "read", description: "Bids you have placed.", schema: { type: "object", properties: { status: { type: "string", enum: ["pending", "accepted_pending_escrow", "accepted", "rejected", "withdrawn"] } }, required: [], additionalProperties: false }, args: (i) => ["bid", "list", ...opt("status", i.status)] },
};

describe("tool and CLI parity", () => {
  it("reads the captured CLI's commands, its own options and their allowed values", () => {
    expect(capture.version).toBe("taskfast 0.19.8");
    expect(surface.get("bid list")!.options.get("status")).toEqual(["pending", "accepted-pending-escrow", "accepted", "rejected", "withdrawn"]);
    expect(surface.get("discover")!.options.get("status")).toEqual(["open", "bidding"]);
    expect(surface.get("task list")!.options.get("kind")).toEqual(["mine", "queue", "posted"]);
    expect(surface.get("discover")!.options.get("capability")).toBeNull();
    expect(surface.get("task")!.leaf).toBe(false);
    // Global options are not the command's own: no tool may pass --env or --api-base.
    expect(surface.get("bid list")!.options.has("env")).toBe(false);
  });

  it("found the three advertised values the CLI refused before gh#91", () => {
    const problems = parityProblems(BEFORE, surface);
    expect(problems).toContain("bid_list: passes --status=accepted_pending_escrow, but the CLI accepts only pending, accepted-pending-escrow, accepted, rejected, withdrawn");
    expect(problems).toContain("task_list: kind is free text, but --kind accepts only mine, queue, posted");
    expect(problems).toContain("task_list: status is free text, but --status accepts only in-progress, under-review, disputed, remedied, assigned");
    expect(problems).toContain("discover: status is free text, but --status accepts only open, bidding");
  });

  it("finds none in the current tools", () => {
    expect(parityProblems(TOOLS, surface)).toEqual([]);
  });

  it("refuses a flag the command lacks, a flag code owns and a command no tool or reason covers", () => {
    const tools: Record<string, ToolSpec> = {
      ...TOOLS,
      settle: { ...TOOLS.settle!, args: (i) => ["settle", "--keystore=/x", "--", String(i.task_id)] },
      me: { ...TOOLS.me!, args: () => ["me", "--env=prod"] },
    };
    const { stake: _, ...excluded } = EXCLUDED;
    const problems = parityProblems(tools, surface, { ...excluded, "task claim": "stale", "nope": "gone" });
    expect(problems).toEqual(expect.arrayContaining([
      "settle: passes --keystore, which code and config own",
      "me: `taskfast me` has no --env",
      "`taskfast stake` has no tool and no reason in EXCLUDED",
      "EXCLUDED names `taskfast task claim`, which a tool runs",
      "EXCLUDED names `taskfast nope`, which the CLI does not have",
    ]));
  });

  it("needs a sample that sets every field of a tool", () => {
    const tools = { ...TOOLS, task_get: { ...TOOLS.task_get!, schema: { ...TOOLS.task_get!.schema, properties: { ...TOOLS.task_get!.schema.properties, cursor: s("page") } } } };
    expect(parityProblems(tools, surface)).toContain("task_get: SAMPLES needs a call that sets every field (task_id, cursor)");
  });

  it("gives a reason for every command the skill prompt calls unsupported", () => {
    const reasoned = (command: string) => Object.keys(EXCLUDED).some((key) => key === command || key.startsWith(`${command} `) || command.startsWith(`${key} `));
    expect(UNSUPPORTED_COMMANDS.filter((command) => !reasoned(command))).toEqual([]);
  });
});
