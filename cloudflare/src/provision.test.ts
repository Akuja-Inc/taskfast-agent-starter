import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { apply, checkInputs, cloudflare, findAccount, plan, ProvisionError, startForm, teardown, type App, type State, type Target } from "./provision.js";

const ACCOUNT = "acc1";
const HOST = "taskfast-agent.owner.workers.dev";
const target: Target = { account: ACCOUNT, host: HOST, email: "owner@example.com", webhooks: false };
const SENTINEL = "cfut_SENTINEL_9f8e7d6c5b4a";

// An in-memory Access API behind a real fetch signature, so `cloudflare()` runs as shipped.
function fakeCloudflare(o: { apps?: App[]; org?: string | null; deny?: string } = {}) {
  const apps = new Map((o.apps ?? []).map((app) => [app.id, app]));
  const calls: { method: string; path: string; authorization: string; body?: string }[] = [];
  let next = 1;
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = url.slice("https://api.cloudflare.com/client/v4".length);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : undefined;
    calls.push({ method, path, authorization: String((init.headers as Record<string, string>).authorization), ...(body ? { body } : {}) });
    const reply = (status: number, result: unknown, errors: unknown[] = []) => new Response(JSON.stringify({ success: status < 300, result, errors }), { status });
    if (o.deny && path.includes(o.deny)) return reply(403, null, [{ message: "Authentication error" }]);
    if (path === "/accounts?per_page=50") return reply(200, [{ id: ACCOUNT }]);
    if (path.endsWith("/access/organizations")) return reply(200, o.org === null ? null : { auth_domain: o.org ?? "team.cloudflareaccess.com" });
    const base = `/accounts/${ACCOUNT}/access/apps`;
    if (method === "GET" && path.startsWith(`${base}?`)) return reply(200, path.includes("page=1") ? [...apps.values()] : []);
    if (method === "POST" && path === base) {
      const app = { ...(JSON.parse(body!) as App), id: `app${next++}`, aud: `aud${next}` };
      apps.set(app.id, app);
      return reply(200, app);
    }
    const id = path.slice(base.length + 1);
    if (method === "GET") return apps.has(id) ? reply(200, apps.get(id)) : reply(404, null, [{ message: "not found" }]);
    if (method === "PUT") { const app = { ...apps.get(id)!, ...(JSON.parse(body!) as App), id }; apps.set(id, app); return reply(200, app); }
    if (method === "DELETE") { apps.delete(id); return reply(200, { id }); }
    return reply(404, null);
  }) as unknown as typeof fetch;
  return { api: cloudflare(SENTINEL, fetcher), apps, calls, writes: () => calls.filter((c) => c.method !== "GET") };
}
const recorder = () => {
  const saved: State[] = [];
  const deployed: { teamDomain: string; aud: string }[] = [];
  return { saved, deployed, save: (s: State) => { saved.push(structuredClone(s)); }, deploy: async (v: { teamDomain: string; aud: string }) => { deployed.push(v); } };
};

describe("provisioning", () => {
  it("creates one owner-only app on a fresh account, records it and deploys its AUD", async () => {
    const cf = fakeCloudflare();
    const r = recorder();
    const p = await plan(cf.api, target);
    expect(p.steps.map((s) => s.kind)).toEqual(["ok", "create", "create"]);
    const done = await apply(cf.api, p, r);
    const app = [...cf.apps.values()][0]!;
    expect(app).toMatchObject({ type: "self_hosted", domain: HOST, policies: [{ decision: "allow", include: [{ email: { email: "owner@example.com" } }] }] });
    expect(done.state).toEqual({ account: ACCOUNT, host: HOST, teamDomain: "https://team.cloudflareaccess.com", aud: app.aud, apps: { console: app.id } });
    expect(r.saved.at(-1)).toEqual(done.state);
    expect(r.deployed).toEqual([{ teamDomain: "https://team.cloudflareaccess.com", aud: app.aud }]);
  });

  it("changes nothing on a rerun, with or without the state file", async () => {
    const cf = fakeCloudflare();
    const r = recorder();
    const first = await apply(cf.api, await plan(cf.api, target), r);
    const before = cf.writes().length;
    for (const state of [first.state, undefined]) {
      const p = await plan(cf.api, target, state);
      expect(p.steps.filter((s) => s.kind !== "ok").map((s) => s.text)).toEqual(["Deploy the Worker with this team domain and AUD tag"]);
      await apply(cf.api, p, r);
    }
    expect(cf.writes().length).toBe(before);
    expect(cf.apps.size).toBe(1);
  });

  it("makes no write call on a dry run (plan only)", async () => {
    const cf = fakeCloudflare();
    await plan(cf.api, { ...target, webhooks: true });
    expect(cf.writes()).toEqual([]);
  });

  it("refuses an app for this hostname that setup did not make, and never touches it", async () => {
    const cf = fakeCloudflare({ apps: [{ id: "theirs", name: "Team portal", domain: HOST, policies: [] }] });
    await expect(plan(cf.api, target)).rejects.toThrow(/did not make it/);
    expect(cf.writes()).toEqual([]);
  });

  it("replaces a different owner email only when told to", async () => {
    const cf = fakeCloudflare();
    const r = recorder();
    await apply(cf.api, await plan(cf.api, target), r);
    const moved = { ...target, email: "new@example.com" };
    const p = await plan(cf.api, moved);
    expect(p.emailDiffers).toBe("owner@example.com");
    await expect(apply(cf.api, p, r)).rejects.toThrow(/Confirm the change/);
    await apply(cf.api, p, { ...r, replaceEmail: true });
    expect([...cf.apps.values()][0]!.policies).toEqual([{ name: "Owner only", decision: "allow", include: [{ email: { email: "new@example.com" } }] }]);
  });

  it("adds the webhook bypass app on its own path", async () => {
    const cf = fakeCloudflare();
    const done = await apply(cf.api, await plan(cf.api, { ...target, webhooks: true }), recorder());
    expect(cf.apps.get(done.state.apps.webhook!)).toMatchObject({ domain: `${HOST}/webhooks/taskfast`, policies: [{ decision: "bypass", include: [{ everyone: {} }] }] });
  });

  it("records the app before a failed deploy, so a rerun only redeploys", async () => {
    const cf = fakeCloudflare();
    const r = recorder();
    await expect(apply(cf.api, await plan(cf.api, target), { ...r, deploy: async () => { throw new ProvisionError("deploy failed"); } })).rejects.toThrow("deploy failed");
    expect(r.saved).toHaveLength(1);
    const again = await plan(cf.api, target, r.saved[0]);
    expect(again.console?.id).toBe(r.saved[0]!.apps.console);
    await apply(cf.api, again, r);
    expect(cf.apps.size).toBe(1);
  });

  it("names the missing permission and the missing organization", async () => {
    await expect(plan(fakeCloudflare({ deny: "/access/organizations" }).api, target)).rejects.toThrow("This token lacks Access: Organizations, Identity Providers, and Groups Read");
    await expect(plan(fakeCloudflare({ deny: "/access/apps" }).api, target)).rejects.toThrow("This token lacks Access: Apps and Policies Write");
    await expect(plan(fakeCloudflare({ org: null }).api, target)).rejects.toThrow(/no Zero Trust organization/);
    await expect(findAccount(fakeCloudflare({ deny: "/accounts?" }).api)).rejects.toThrow(/Set CLOUDFLARE_ACCOUNT_ID/);
  });

  it("tears down only recorded apps that still cover their host", async () => {
    const cf = fakeCloudflare({ apps: [{ id: "other", name: "x", domain: "elsewhere.example" }] });
    const done = await apply(cf.api, await plan(cf.api, target), recorder());
    const result = await teardown(cf.api, { ...done.state, apps: { console: done.state.apps.console, webhook: "other" } });
    expect(result.deleted).toEqual([done.state.apps.console]);
    expect(result.kept).toHaveLength(1);
    expect(cf.apps.has("other")).toBe(true);
  });

  it("accepts only an https workers.dev URL and one exact email", () => {
    expect(checkInputs(` https://${HOST}/ `, "Owner@Example.com")).toEqual({ host: HOST, email: "owner@example.com" });
    for (const url of [`http://${HOST}`, `https://${HOST}/api`, "https://example.com", `https://${HOST}:8443`]) expect(() => checkInputs(url, "a@b.co")).toThrow(/workers\.dev/);
    for (const email of ["*@example.com", "a@b.co,c@d.co", "nobody"]) expect(() => checkInputs(`https://${HOST}`, email)).toThrow(/one exact email/);
  });
});

// A raw request, so Host and Origin are exactly what the test says.
function hit(port: number, o: { method?: string; path?: string; host?: string; origin?: string; bearer?: string; body?: unknown }) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: o.method ?? "POST", path: o.path ?? "/api/check", headers: {
      host: o.host ?? `127.0.0.1:${port}`, ...(o.origin ? { origin: o.origin } : {}), ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}), "content-type": "application/json",
    } }, (res) => { let text = ""; res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, text })); });
    req.on("error", reject);
    req.end(o.body === undefined ? undefined : JSON.stringify(o.body));
  });
}

describe("the local form", () => {
  async function form(cf = fakeCloudflare(), linkMs?: number, hold?: Promise<void>) {
    const r = recorder();
    const logs: string[] = [];
    const f = await startForm({ page: "<!doctype html><title>setup</title>", connect: async () => { await hold; return { api: cf.api, account: ACCOUNT }; }, state: () => r.saved.at(-1), save: r.save, deploy: r.deploy, ...(linkMs ? { linkMs } : {}) });
    const link = new URL(f.url).hash.slice("#token=".length);
    return { f, link, cf, r, logs };
  }

  it("binds to 127.0.0.1 only", async () => {
    const { f } = await form();
    expect(f.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]{64}$/);
    await f.close();
  });

  it("refuses a foreign Host, a foreign Origin, and a missing or wrong link token", async () => {
    const { f, link } = await form();
    expect((await hit(f.port, { method: "GET", path: "/", host: "evil.example" })).status).toBe(403);
    expect((await hit(f.port, { bearer: link, origin: "https://evil.example", body: {} })).status).toBe(403);
    // A cross-site form post cannot set the bearer header: that is the CSRF check.
    expect((await hit(f.port, { body: { token: SENTINEL, workerUrl: `https://${HOST}`, email: "a@b.co" } })).status).toBe(401);
    expect((await hit(f.port, { bearer: "0".repeat(64), body: {} })).status).toBe(401);
    expect((await hit(f.port, { method: "GET", path: "/" })).status).toBe(200);
    await f.close();
  });

  it("never returns, logs or keeps the token, and sends it only in the Authorization header", async () => {
    const { f, link, cf, r } = await form();
    const seen: string[] = [];
    const log = console.log, error = console.error;
    console.log = (...a: unknown[]) => { seen.push(a.join(" ")); };
    console.error = (...a: unknown[]) => { seen.push(a.join(" ")); };
    try {
      const check = await hit(f.port, { bearer: link, body: { token: SENTINEL, workerUrl: `https://${HOST}`, email: "owner@example.com" } });
      const page = await hit(f.port, { method: "GET", path: "/" });
      const created = await hit(f.port, { bearer: link, path: "/api/create", body: {} });
      expect([check.status, created.status]).toEqual([200, 200]);
      seen.push(check.text, page.text, created.text, JSON.stringify(r.saved), JSON.stringify(r.deployed));
      expect(await f.done).toBe("created");
    } finally { console.log = log; console.error = error; }
    expect(seen.join("\n")).not.toContain(SENTINEL);
    for (const call of cf.calls) {
      expect(call.authorization).toBe(`Bearer ${SENTINEL}`);
      expect(call.path + (call.body ?? "")).not.toContain(SENTINEL);
    }
  });

  it("keeps a refused check's token out of its error", async () => {
    const cf = fakeCloudflare({ deny: "/access/organizations" });
    const { f, link } = await form(cf);
    const reply = await hit(f.port, { bearer: link, body: { token: SENTINEL, workerUrl: `https://${HOST}`, email: "owner@example.com" } });
    expect(reply.status).toBe(422);
    expect(reply.text).toContain("This token lacks");
    expect(reply.text).not.toContain(SENTINEL);
    await f.close();
  });

  it("refuses Create before Check, and a second request while one runs", async () => {
    let release!: () => void;
    const { f, link } = await form(undefined, undefined, new Promise<void>((resolve) => { release = resolve; }));
    expect((await hit(f.port, { bearer: link, path: "/api/create", body: {} })).status).toBe(409);
    const body = { token: SENTINEL, workerUrl: `https://${HOST}`, email: "owner@example.com" };
    const first = hit(f.port, { bearer: link, body });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await hit(f.port, { bearer: link, body })).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    await f.close();
  });

  it("stops when the link expires", async () => {
    const { f } = await form(undefined, 20);
    expect(await f.done).toBe("expired");
    await expect(hit(f.port, { method: "GET", path: "/" })).rejects.toThrow();
  });
});
