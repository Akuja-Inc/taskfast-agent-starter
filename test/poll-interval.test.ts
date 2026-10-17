import { describe, expect, it } from "vitest";
import { agentFile, parseAgentFile, parseAgentSpec } from "../src/core/spec.js";
import { example } from "./example.js";

describe("pollIntervalMinutes", () => {
  it("keeps old agent files valid without materializing the default", () => {
    expect(parseAgentSpec(example("careful-worker"))).not.toHaveProperty("pollIntervalMinutes");
  });

  it.each([1, 15, 1440])("round-trips %i minutes through both parsers and file serialization", (minutes) => {
    const spec = parseAgentSpec({ ...example("careful-worker"), pollIntervalMinutes: minutes });
    expect(spec).toHaveProperty("pollIntervalMinutes", minutes);
    expect(parseAgentFile(JSON.parse(JSON.stringify(agentFile(spec))))).toHaveProperty("pollIntervalMinutes", minutes);
    expect(agentFile(spec)).not.toHaveProperty("instructions");
  });

  it.each([0, -1, 0.5, 1.5, 1441, NaN, Infinity, -Infinity, "5", "", null, true])("rejects invalid interval %s", (value) => {
    expect(() => parseAgentSpec({ ...example("careful-worker"), pollIntervalMinutes: value }))
      .toThrow("pollIntervalMinutes must be a whole number from 1 to 1440");
  });
});
