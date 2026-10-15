import { describe, expect, it } from "vitest";
import { buildSystemPrompt, MANNER } from "./prompt.js";
import type { AgentSpec, Role, Temperament } from "./types.js";

const spec = (role: Role, temperament: Temperament): AgentSpec => ({
  role,
  model: "anthropic:claude-haiku-5-5",
  instructions: "  You are Owen Hollis, who runs Hollis Cycle Repair. Bike servicing and a small online parts shop.\n\nWhat you want right now: keep costs predictable and pay fairly for good work.\n\n",
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

  it("opens with the instructions, trimmed, then the manner and the marketplace side", () => {
    expect(buildSystemPrompt(spec("poster", "brisk"))).toBe(`You are Owen Hollis, who runs Hollis Cycle Repair. Bike servicing and a small online parts shop.

What you want right now: keep costs predictable and pay fairly for good work.
You are ${MANNER.brisk}.
You hire people for jobs through a freelance marketplace, writing the way you normally would.`);
  });

  it("describes the marketplace side for each role", () => {
    expect(buildSystemPrompt(spec("poster", "patient"))).toContain("You hire people for jobs");
    expect(buildSystemPrompt(spec("worker", "patient"))).toContain("You find and do work");
    expect(buildSystemPrompt(spec("both", "patient"))).toContain("take on work yourself");
  });
});
