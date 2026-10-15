import { describe, expect, it } from "vitest";
import { agentFile, hasStaleCharacter, MAX_INSTRUCTIONS, parseAgentFile, parseAgentSpec } from "./spec.js";

const valid = () => ({
  role: "worker",
  model: "anthropic:claude-haiku-5-5",
  instructions: "You are Priya Banerjee, who runs Banerjee Translations.\n\nWhat you want right now: build a few long-term working relationships.\n" as unknown,
  dials: { competence: 0.85, diligence: 0.9, priceSensitivity: 0.4, temperament: "exacting" } as Record<string, unknown>,
});
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
  it("returns the same spec, and agentFile drops only the instructions", () => {
    const spec = parseAgentSpec(valid());
    expect(spec).toEqual(valid());
    const { instructions: _, ...file } = valid();
    expect(agentFile(spec)).toEqual(file);
    expect(parseAgentFile(file)).toEqual(file);
  });

  it("ignores a stale character in agent.json, flags it for a warning, and keeps instructions out of agent.json", () => {
    const { instructions: _, ...file } = valid();
    const stale = { ...file, character: { name: "Priya" } };
    expect(parseAgentFile(stale)).toEqual(file);
    expect(hasStaleCharacter(stale)).toBe(true);
    expect(hasStaleCharacter(file)).toBe(false);
    expect(() => parseAgentFile(valid())).toThrow(/agent\.instructions is not a known field/);
  });

  it.each([
    ["an unknown top-level field", { ...valid(), env: "prod" }, /agent\.env is not a known field/],
    ["a retired seed field", { ...valid(), seed: 7 }, /agent\.seed is not a known field/],
    ["an unknown dial", withDials({ temprament: "curt" }), /dials\.temprament is not a known field/],
    ["an unknown role", { ...valid(), role: "admin" }, /role must be one of poster, worker, both/],
    ["a model without a provider", { ...valid(), model: "claude-haiku" }, /provider:model/],
    ["missing instructions", { ...valid(), instructions: undefined }, /instructions \(INSTRUCTIONS\.md\) must be a non-empty string/],
    ["blank instructions", { ...valid(), instructions: " \n " }, /instructions \(INSTRUCTIONS\.md\) must be a non-empty string/],
    ["instructions over the limit", { ...valid(), instructions: "x".repeat(MAX_INSTRUCTIONS + 1) }, /at most 20000 characters/],
    ["dials as an array", { ...valid(), dials: [] }, /dials must be an object/],
    ["competence above 1", withDials({ competence: 1.2 }), /competence must be a number from 0 to 1/],
    ["NaN diligence", withDials({ diligence: NaN }), /diligence must be/],
    ["a string price sensitivity", withDials({ priceSensitivity: "0.4" }), /priceSensitivity must be/],
    ["an unknown temperament", withDials({ temperament: "hostile" }), /temperament must be one of/],
    ["an inherited key as temperament", withDials({ temperament: "toString" }), /temperament must be one of/],
  ])("refuses %s", (_name, raw, why) => {
    expect(() => parseAgentSpec(raw)).toThrow(why);
  });
});
