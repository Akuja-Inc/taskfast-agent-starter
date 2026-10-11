import { describe, expect, it } from "vitest";
import { parseAgentSpec } from "./spec.js";

const valid = () => ({
  role: "worker",
  model: "anthropic:claude-haiku-5-5",
  character: {
    name: "Priya Banerjee",
    businessName: "Banerjee Translations",
    businessDescription: "Spanish and Portuguese translation for small publishers.",
    goals: "build a few long-term working relationships",
  } as Record<string, unknown>,
  dials: { competence: 0.85, diligence: 0.9, priceSensitivity: 0.4, temperament: "exacting" } as Record<string, unknown>,
});
const withChar = (over: object, top: object = {}) => ({ ...valid(), ...top, character: { ...valid().character, ...over } });
const withDials = (over: object) => ({ ...valid(), dials: { ...valid().dials, ...over } });

describe("parseAgentSpec limits", () => {
  it("accepts no limits, either limit, or both", () => {
    expect(parseAgentSpec(valid())).not.toHaveProperty("limits");
    expect(parseAgentSpec({ ...valid(), limits: { dailyUsd: 50 } }).limits).toEqual({ dailyUsd: 50 });
    expect(parseAgentSpec({ ...valid(), limits: { perJobUsd: 20, dailyUsd: 50 } }).limits).toEqual({ perJobUsd: 20, dailyUsd: 50 });
  });

  it.each([
    ["a zero limit", { perJobUsd: 0 }, /limits.perJobUsd must be a positive number/],
    ["a string limit", { dailyUsd: "50" }, /limits.dailyUsd must be a positive number/],
    ["an unknown limit", { weeklyUsd: 100 }, /limits.weeklyUsd is not a known field/],
  ])("refuses %s", (_n, limits, why) => {
    expect(() => parseAgentSpec({ ...valid(), limits })).toThrow(why);
  });
});

describe("parseAgentSpec", () => {
  it("accepts a worker with no budget and returns the same spec", () => {
    expect(parseAgentSpec(valid())).toEqual(valid());
  });

  it("requires a budget for a poster or a both-sides agent", () => {
    for (const role of ["poster", "both"]) {
      expect(() => parseAgentSpec({ ...valid(), role })).toThrow(/budgetUsd is required/);
      expect(parseAgentSpec(withChar({ budgetUsd: 40 }, { role })).character.budgetUsd).toBe(40);
    }
  });

  it.each([
    ["an unknown top-level field", { ...valid(), env: "prod" }, /agent\.env is not a known field/],
    ["a retired seed field", { ...valid(), seed: 7 }, /agent\.seed is not a known field/],
    ["an unknown character field", withChar({ manner: "x" }), /character\.manner is not a known field/],
    ["an unknown dial", withDials({ temprament: "curt" }), /dials\.temprament is not a known field/],
    ["an unknown role", { ...valid(), role: "admin" }, /role must be one of poster, worker, both/],
    ["a model without a provider", { ...valid(), model: "claude-haiku" }, /provider:model/],
    ["a null character", { ...valid(), character: null }, /character must be an object/],
    ["dials as an array", { ...valid(), dials: [] }, /dials must be an object/],
    ["a blank name", withChar({ name: "  " }), /character\.name must be a non-empty string/],
    ["a zero budget", withChar({ budgetUsd: 0 }), /budgetUsd must be a positive number/],
    ["an infinite budget", withChar({ budgetUsd: Infinity }), /budgetUsd must be a positive number/],
    ["competence above 1", withDials({ competence: 1.2 }), /competence must be a number from 0 to 1/],
    ["NaN diligence", withDials({ diligence: NaN }), /diligence must be/],
    ["a string price sensitivity", withDials({ priceSensitivity: "0.4" }), /priceSensitivity must be/],
    ["an unknown temperament", withDials({ temperament: "hostile" }), /temperament must be one of/],
    ["an inherited key as temperament", withDials({ temperament: "toString" }), /temperament must be one of/],
  ])("refuses %s", (_name, raw, why) => {
    expect(() => parseAgentSpec(raw)).toThrow(why);
  });
});
