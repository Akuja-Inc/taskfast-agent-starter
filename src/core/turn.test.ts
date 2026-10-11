import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { clip, decideNext } from "./turn.js";
import type { AgentSpec } from "./types.js";

const SPEC: AgentSpec = {
  role: "worker",
  model: "anthropic:claude-sonnet-5-5",
  character: { name: "Owen Hollis", businessName: "Hollis Cycle Repair", businessDescription: "Bike servicing.", goals: "steady work" },
  dials: { competence: 0.314159, diligence: 0.271828, priceSensitivity: 0.161803, temperament: "brisk" },
};
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

// A mock model that answers with the given content and records what it was sent.
function model(content: unknown[]) {
  const calls: unknown[] = [];
  const m = new MockLanguageModelV4({
    doGenerate: async (opts: unknown) => {
      calls.push(opts);
      return { content, finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] } as never;
    },
  });
  return { m, sent: () => JSON.stringify(calls) };
}

describe("decideNext", () => {
  it("returns the model's tool call without running anything", async () => {
    const { m } = model([{ type: "tool-call", toolCallId: "c1", toolName: "task_get", input: JSON.stringify({ task_id: "x" }) }]);
    expect(await decideNext(m, { spec: SPEC, memory: [], events: [], transcript: [] })).toEqual({ type: "call", tool: "task_get", input: { task_id: "x" } });
  });

  it("ends the turn when the model answers in words", async () => {
    const { m } = model([{ type: "text", text: "  Nothing to do until the poster replies.  " }]);
    expect(await decideNext(m, { spec: SPEC, memory: [], events: [], transcript: [] })).toEqual({ type: "end", note: "Nothing to do until the poster replies." });
  });

  it("shows the model its notes, new events and this turn's results, but never its dials", async () => {
    const { m, sent } = model([{ type: "text", text: "ok" }]);
    await decideNext(m, {
      spec: SPEC,
      memory: ["poster prefers short updates"],
      events: [{ event_id: "ev-1", event: "task_assigned", task_id: "t-9" }],
      transcript: [{ tool: "task_get", input: { task_id: "t-9" }, result: { title: "Logo" } }],
    });
    const s = sent();
    for (const v of ["Owen Hollis", "poster prefers short updates", "task_assigned", "Logo", "bid_create"]) expect(s).toContain(v);
    for (const v of ["0.314159", "0.271828", "0.161803", "temperament", "persona", "synthetic"]) expect(s).not.toContain(v);
  });

  it("throws on a model error, so the caller commits nothing", async () => {
    const m = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("overloaded"); } });
    await expect(decideNext(m, { spec: SPEC, memory: [], events: [], transcript: [] })).rejects.toThrow(/overloaded/);
  });
});

describe("clip", () => {
  it("passes a small value through and cuts a large one to a marked head", () => {
    expect(clip({ id: "t-1", title: "Logo" })).toEqual({ id: "t-1", title: "Logo" });
    const big = { tasks: Array.from({ length: 2000 }, (_, i) => ({ id: `t-${i}`, title: "x".repeat(20) })) };
    const c = clip(big) as { truncated: string; head: string };
    expect(c.head).toHaveLength(8000);
    expect(c.truncated).toMatch(/^\d+ more characters$/);
    expect(JSON.stringify(big).startsWith(c.head)).toBe(true);
  });
});

