import { expect, it } from "vitest";
import { prepare } from "./tools.js";
it("uses the same business key for differently cased UUIDs", () => {
  const task = "ABCDEF01-1234-4123-8123-ABCDEF012345";
  const original = prepare("bid_create", { task_id: task, price: "5.00" });
  const later = prepare("bid_create", { task_id: task.toLowerCase(), price: "6.00" });
  expect(original.key).toBe(later.key);
  expect(original.input.task_id).toBe(task.toLowerCase());
});
