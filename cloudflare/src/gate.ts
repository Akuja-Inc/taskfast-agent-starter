// What the Worker checks before it forwards a console request to the agent's
// Durable Object. Pure, so Node tests cover it; worker.ts only wires it up.
import { timingSafeEqual } from "node:crypto";
import { PAGE } from "../../src/console-page.js";
import { consoleNavigation } from "../../src/console-navigation.js";
import { PAGE_POLICY } from "../../src/console.js";
import { verifyAccess, type AccessConfig, type FetchKeys } from "./access.js";

export interface GateOptions {
  access: AccessConfig;
  // The console page's bearer token: 64 hex characters, a Worker secret.
  token: string;
  fetchKeys?: FetchKeys;
  now?: number;
}

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
export const reply = (status: number, body: unknown, type = "application/json"): Response => new Response(
  type === "application/json" ? JSON.stringify(body) : String(body),
  { status, headers: { ...HEADERS, "content-type": `${type}; charset=utf-8`, ...(type === "text/html" ? { "content-security-policy": PAGE_POLICY } : {}) } },
);
const { read: readDestination } = consoleNavigation();

function sameToken(header: string | null, token: string): boolean {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

// A Response to send as is, or "forward" when the request may reach the agent.
// Reads only until writes go through policy (#144 PR4): every other method is refused here.
export async function gate(request: Request, o: GateOptions): Promise<Response | "forward"> {
  if (!/^[0-9a-f]{64}$/.test(o.token)) return reply(500, { error: "console token secret is missing or malformed" });
  const access = await verifyAccess(request.headers.get("cf-access-jwt-assertion"), o.access, { fetchKeys: o.fetchKeys, now: o.now });
  if (!access.ok) return reply(403, { error: access.reason });
  const url = new URL(request.url);
  // The page must talk only to its own origin, like the local console.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return reply(403, { error: "unknown origin" });
  if (request.method !== "GET") return reply(405, { error: "this console is read-only for now" });
  const rawPath = url.pathname;
  if (!rawPath.startsWith("/api/")) return readDestination(rawPath, "").invalid ? reply(404, { error: "not found" }) : reply(200, PAGE, "text/html");
  if (!sameToken(request.headers.get("authorization"), o.token)) return reply(401, { error: "missing or wrong console token" });
  return "forward";
}
