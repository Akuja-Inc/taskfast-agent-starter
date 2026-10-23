// Cloudflare Access check. The Worker runs it on every console request before it
// touches the agent's Durable Object, so a refused request reads and writes nothing.
// RS256 only, keys from the team's certs endpoint, and `iss`, `aud` and `exp` checked
// here: the Worker never trusts that Access sat in front of it.

export interface AccessConfig {
  // https://<team>.cloudflareaccess.com, no trailing slash.
  teamDomain: string;
  // The Access application's AUD tag.
  audience: string;
}
type Jwk = JsonWebKey & { kid?: string };
export type FetchKeys = (url: string) => Promise<{ keys: Jwk[] }>;

const KEY_TTL_MS = 10 * 60_000;
const SKEW_S = 60;
let cache: { url: string; at: number; keys: Jwk[] } | undefined;

const decoder = new TextDecoder();
function base64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
const json = (part: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(decoder.decode(base64url(part)));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
  return value as Record<string, unknown>;
};

async function keysFor(url: string, fetchKeys: FetchKeys, now: number, refresh: boolean): Promise<Jwk[]> {
  if (!refresh && cache?.url === url && now - cache.at < KEY_TTL_MS) return cache.keys;
  const { keys } = await fetchKeys(url);
  if (!Array.isArray(keys)) throw new Error("certs endpoint returned no keys");
  cache = { url, at: now, keys };
  return keys;
}

export const fetchAccessKeys: FetchKeys = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`certs endpoint answered ${response.status}`);
  return response.json() as Promise<{ keys: Jwk[] }>;
};

// The verified identity, or why the token was refused. Never throws on bad input.
export async function verifyAccess(token: string | null, config: AccessConfig, o: { fetchKeys?: FetchKeys; now?: number } = {}): Promise<{ ok: true; email?: string } | { ok: false; reason: string }> {
  if (!token) return { ok: false, reason: "missing Access token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed Access token" };
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try { header = json(parts[0]); claims = json(parts[1]); } catch { return { ok: false, reason: "malformed Access token" }; }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "unsupported Access token algorithm" };
  const now = o.now ?? Date.now();
  const url = `${config.teamDomain}/cdn-cgi/access/certs`;
  const fetchKeys = o.fetchKeys ?? fetchAccessKeys;
  let jwk: Jwk | undefined;
  try {
    jwk = (await keysFor(url, fetchKeys, now, false)).find((key) => key.kid === header.kid);
    // A rotated key the cache has not seen yet.
    jwk ??= (await keysFor(url, fetchKeys, now, true)).find((key) => key.kid === header.kid);
  } catch { return { ok: false, reason: "Access keys are unavailable" }; }
  if (!jwk) return { ok: false, reason: "unknown Access signing key" };
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { valid = false; }
  if (!valid) return { ok: false, reason: "bad Access token signature" };
  if (claims.iss !== config.teamDomain) return { ok: false, reason: "Access token from another team" };
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(config.audience)) return { ok: false, reason: "Access token for another application" };
  const seconds = now / 1000;
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < seconds) return { ok: false, reason: "expired Access token" };
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > seconds) return { ok: false, reason: "Access token not valid yet" };
  return { ok: true, ...(typeof claims.email === "string" ? { email: claims.email } : {}) };
}

// Test-only: forget cached keys.
export function resetAccessKeys(): void { cache = undefined; }
