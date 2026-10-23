import { createSign, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { resetAccessKeys } from "./access.js";
import { gate } from "./gate.js";

const access = { teamDomain: "https://owner.cloudflareaccess.com", audience: "aud-tag" };
const NOW = Date.parse("2026-10-23T12:00:00Z");
const TOKEN = "ab".repeat(32);
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys = { keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: "k1" }] };
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const head = b64({ alg: "RS256", kid: "k1" });
const body = b64({ iss: access.teamDomain, aud: [access.audience], exp: NOW / 1000 + 600 });
const jwt = `${head}.${body}.${createSign("RSA-SHA256").update(`${head}.${body}`).sign(pair.privateKey).toString("base64url")}`;

const check = (path: string, headers: Record<string, string> = {}, method = "GET", token = TOKEN) =>
  gate(new Request(`https://agent.example${path}`, { method, headers }), { access, token, now: NOW, fetchKeys: async () => keys });
const status = async (decision: Response | "forward") => decision === "forward" ? "forward" : decision.status;
const signedIn = { "cf-access-jwt-assertion": jwt };
const api = { ...signedIn, authorization: `Bearer ${TOKEN}` };

beforeEach(() => resetAccessKeys());

describe("gate", () => {
  it("refuses everything without a valid Access token, before reading the token or path", async () => {
    for (const path of ["/", "/api/agents", "/api/agents/my-agent", "/nope"]) {
      expect(await status(await check(path))).toBe(403);
      expect(await status(await check(path, { authorization: `Bearer ${TOKEN}`, "cf-access-jwt-assertion": "x.y.z" }))).toBe(403);
    }
  });
  it("serves the console page, with its content policy, to a signed-in owner", async () => {
    const page = await check("/agents/my-agent", signedIn);
    expect(page).not.toBe("forward");
    const response = page as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await response.text()).toContain("<html");
  });
  it("needs the console token for the API", async () => {
    expect(await status(await check("/api/agents", signedIn))).toBe(401);
    expect(await status(await check("/api/agents", { ...signedIn, authorization: `Bearer ${"cd".repeat(32)}` }))).toBe(401);
    expect(await check("/api/agents", api)).toBe("forward");
    expect(await check("/api/agents/my-agent", api)).toBe("forward");
  });
  it("is read-only and same-origin", async () => {
    expect(await status(await check("/api/agents/my-agent", api, "POST"))).toBe(405);
    expect(await status(await check("/api/agents/my-agent", { ...api, origin: "https://evil.example" }))).toBe(403);
    expect(await check("/api/agents/my-agent", { ...api, origin: "https://agent.example" })).toBe("forward");
  });
  it("refuses to serve without a well-formed console token secret", async () => {
    expect(await status(await check("/api/agents", api, "GET", ""))).toBe(500);
    expect(await status(await check("/api/agents", { ...signedIn, authorization: "Bearer " }, "GET", ""))).toBe(500);
  });
});
