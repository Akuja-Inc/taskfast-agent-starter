import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhook } from "./webhook.js";

const SECRET = "whsec_test";
const NOW = Date.parse("2026-10-23T12:00:00Z");
const body = JSON.stringify({ event_id: "e1", event: "bid_received", task_id: "t1", data: { bid_id: "b1" } });
const sign = (text: string, timestamp: string, secret = SECRET) => createHmac("sha256", secret).update(`${timestamp}.${text}`).digest("hex");
const headers = (o: { signature?: string; timestamp?: string } = {}) => {
  const timestamp = o.timestamp ?? new Date(NOW).toISOString();
  return new Headers({ "x-webhook-timestamp": timestamp, "x-webhook-signature": o.signature ?? sign(body, timestamp) });
};

describe("verifyWebhook", () => {
  it("accepts the platform's signature over timestamp and body", () => {
    expect(verifyWebhook(body, headers(), SECRET, NOW)).toEqual({ ok: true });
  });
  it.each([
    ["no secret configured", () => verifyWebhook(body, headers(), "", NOW), "the WEBHOOK_SECRET secret is not set"],
    ["no headers", () => verifyWebhook(body, new Headers(), SECRET, NOW), "missing webhook signature"],
    ["another secret", () => verifyWebhook(body, headers({ signature: sign(body, new Date(NOW).toISOString(), "other") }), SECRET, NOW), "bad webhook signature"],
    ["an edited body", () => verifyWebhook(body.replace("b1", "b2"), headers(), SECRET, NOW), "bad webhook signature"],
    ["uppercase hex", () => verifyWebhook(body, headers({ signature: sign(body, new Date(NOW).toISOString()).toUpperCase() }), SECRET, NOW), "bad webhook signature"],
    ["a short signature", () => verifyWebhook(body, headers({ signature: "ab" }), SECRET, NOW), "bad webhook signature"],
    ["a timestamp six minutes old", () => verifyWebhook(body, headers({ timestamp: new Date(NOW - 6 * 60_000).toISOString() }), SECRET, NOW), "webhook timestamp is outside 5 minutes"],
    ["a timestamp from the future", () => verifyWebhook(body, headers({ timestamp: new Date(NOW + 6 * 60_000).toISOString() }), SECRET, NOW), "webhook timestamp is outside 5 minutes"],
    ["an unreadable timestamp", () => verifyWebhook(body, headers({ timestamp: "yesterday" }), SECRET, NOW), "webhook timestamp is outside 5 minutes"],
  ])("refuses %s", (_name, check, reason) => {
    expect(check()).toEqual({ ok: false, reason });
  });
  it("signs the timestamp header as sent, not a reformatted one", () => {
    const timestamp = "2026-10-23T12:00:00.000000Z";
    expect(verifyWebhook(body, headers({ timestamp, signature: sign(body, timestamp) }), SECRET, NOW)).toEqual({ ok: true });
  });
});
