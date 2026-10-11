import { describe, expect, it } from "vitest";
import { buildSystemPrompt, MANNER } from "./prompt.js";
import type { AgentSpec, Role, Temperament } from "./types.js";

const spec = (role: Role, temperament: Temperament): AgentSpec => ({
  role,
  model: "anthropic:claude-haiku-5-5",
  character: {
    name: "Owen Hollis",
    businessName: "Hollis Cycle Repair",
    businessDescription: "Hollis Cycle Repair does bike servicing and a small online parts shop.",
    goals: "keep costs predictable and pay fairly for good work",
    budgetUsd: 37,
  },
  dials: { competence: 0.123456, diligence: 0.654321, priceSensitivity: 0.987654, temperament },
});

describe("buildSystemPrompt", () => {
  it("never interpolates the numeric dials, the seed or the model", () => {
    for (const role of ["poster", "worker", "both"] as const) {
      for (const t of Object.keys(MANNER) as Temperament[]) {
        const prompt = buildSystemPrompt(spec(role, t));
        expect(prompt).toContain("Owen Hollis");
        expect(prompt).toContain(MANNER[t]);
        for (const v of ["0.123456", "0.654321", "0.987654", "claude-haiku"]) expect(prompt).not.toContain(v);
        for (const w of ["persona", "synthetic", "test", "dial", "temperament"]) expect(prompt.toLowerCase()).not.toContain(w);
      }
    }
  });

  it("states a budget only to an agent that posts", () => {
    expect(buildSystemPrompt(spec("poster", "brisk"))).toContain("$37");
    expect(buildSystemPrompt(spec("both", "brisk"))).toContain("$37");
    expect(buildSystemPrompt(spec("worker", "brisk"))).not.toContain("$37");
  });

  it("describes the marketplace side for each role", () => {
    expect(buildSystemPrompt(spec("poster", "patient"))).toContain("You hire people for jobs");
    expect(buildSystemPrompt(spec("worker", "patient"))).toContain("You find and do work");
    expect(buildSystemPrompt(spec("both", "patient"))).toContain("take on work yourself");
  });
});
