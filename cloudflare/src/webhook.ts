// TaskFast webhook signatures (test/fixtures/openapi.yaml, configureWebhook):
// X-Webhook-Signature is lowercase hex HMAC-SHA256(secret, "<X-Webhook-Timestamp>.<raw body>"),
// and the timestamp must be within 5 minutes. The Worker checks this before any
// Durable Object is touched; this route sits outside Cloudflare Access.
import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_PATH = "/webhooks/taskfast";
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
const WINDOW_MS = 5 * 60_000;

export function verifyWebhook(body: string, headers: Headers, secret: string, now = Date.now()): { ok: true } | { ok: false; reason: string } {
  if (!secret) return { ok: false, reason: "the WEBHOOK_SECRET secret is not set" };
  const signature = headers.get("x-webhook-signature");
  const timestamp = headers.get("x-webhook-timestamp");
  if (!signature || !timestamp) return { ok: false, reason: "missing webhook signature" };
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at) || Math.abs(now - at) > WINDOW_MS) return { ok: false, reason: "webhook timestamp is outside 5 minutes" };
  if (!/^[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: "bad webhook signature" };
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex")) ? { ok: true } : { ok: false, reason: "bad webhook signature" };
}
