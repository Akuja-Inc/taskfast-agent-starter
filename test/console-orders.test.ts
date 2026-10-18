import { expect, it } from "vitest";
import { mentionsMoney, ORDER_SAMPLES } from "../src/console-orders.js";

// gh#120: a dollar amount in an order earns the "nothing enforces it" hint.
it.each([["Never spend more than $5", true], ["Cap bids at $20.50", true], ["Skip phone jobs", false], ["Bid in $ only", false], ["Spend 5 dollars", false]])("mentionsMoney(%j) is %s", (text, expected) => {
  expect(mentionsMoney(text)).toBe(expected);
});

it("offers two or three self-running samples per role, none that wait on the owner or name money", () => {
  expect(Object.keys(ORDER_SAMPLES).sort()).toEqual(["both", "poster", "worker"]);
  for (const samples of Object.values(ORDER_SAMPLES)) {
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(samples.length).toBeLessThanOrEqual(3);
    for (const sample of samples) {
      expect(sample).not.toMatch(/\bask\b|\bme\b|\bwait\b/i);
      expect(mentionsMoney(sample)).toBe(false);
    }
  }
});
