import { generateKeyPairSync, createSign } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { resetAccessKeys, verifyAccess, type FetchKeys } from "./access.js";

const config = { teamDomain: "https://owner.cloudflareaccess.com", audience: "aud-tag" };
const NOW = Date.parse("2026-10-23T12:00:00Z");
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function mint(claims: Record<string, unknown> = {}, o: { kid?: string; alg?: string; key?: typeof pair.privateKey } = {}) {
  const head = b64({ alg: o.alg ?? "RS256", kid: o.kid ?? "k1", typ: "JWT" });
  const body = b64({ iss: config.teamDomain, aud: [config.audience], exp: NOW / 1000 + 600, email: "owner@example.com", ...claims });
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(o.key ?? pair.privateKey).toString("base64url");
  return `${head}.${body}.${signature}`;
}
let fetches = 0;
const fetchKeys: FetchKeys = async (url) => {
  expect(url).toBe("https://owner.cloudflareaccess.com/cdn-cgi/access/certs");
  fetches++;
  return { keys: [jwk] };
};
const check = (token: string | null) => verifyAccess(token, config, { fetchKeys, now: NOW });

beforeEach(() => { resetAccessKeys(); fetches = 0; });

describe("verifyAccess", () => {
  it("accepts a token signed by the team for this application", async () => {
    expect(await check(mint())).toEqual({ ok: true, email: "owner@example.com" });
  });
  it.each([
    ["missing", null, "missing Access token"],
    ["empty", "", "missing Access token"],
    ["not a JWT", "abc", "malformed Access token"],
    ["garbage parts", "a.b.c", "malformed Access token"],
    ["expired", mint({ exp: NOW / 1000 - 120 }), "expired Access token"],
    ["no expiry", mint({ exp: undefined }), "expired Access token"],
    ["not yet valid", mint({ nbf: NOW / 1000 + 600 }), "Access token not valid yet"],
    ["wrong audience", mint({ aud: ["someone-else"] }), "Access token for another application"],
    ["wrong issuer", mint({ iss: "https://attacker.cloudflareaccess.com" }), "Access token from another team"],
    ["another key", mint({}, { key: other.privateKey }), "bad Access token signature"],
    ["unknown kid", mint({}, { kid: "k9" }), "unknown Access signing key"],
    ["alg none", mint({}, { alg: "none" }), "unsupported Access token algorithm"],
    ["HS256", mint({}, { alg: "HS256" }), "unsupported Access token algorithm"],
  ])("refuses a %s token", async (_name, token, reason) => {
    expect(await check(token)).toEqual({ ok: false, reason });
  });
  it("refuses a token whose claims were edited after signing", async () => {
    const [head, , signature] = mint().split(".");
    const forged = `${head}.${b64({ iss: config.teamDomain, aud: [config.audience], exp: NOW / 1000 + 600, email: "intruder@example.com" })}.${signature}`;
    expect(await check(forged)).toEqual({ ok: false, reason: "bad Access token signature" });
  });
  it("accepts a string audience", async () => {
    expect((await check(mint({ aud: config.audience }))).ok).toBe(true);
  });
  it("caches keys, and refetches once for an unseen key id", async () => {
    await check(mint());
    await check(mint());
    expect(fetches).toBe(1);
    await check(mint({}, { kid: "k9" }));
    expect(fetches).toBe(2);
  });
  it("refuses when the certs endpoint fails", async () => {
    const result = await verifyAccess(mint(), config, { fetchKeys: async () => { throw new Error("down"); }, now: NOW });
    expect(result).toEqual({ ok: false, reason: "Access keys are unavailable" });
  });
});
