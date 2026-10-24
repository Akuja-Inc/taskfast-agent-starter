// Puts one owner's Worker behind Cloudflare Access (#144): a self-hosted Access app for
// the workers.dev hostname with one Allow policy for the owner's exact email, and, when
// TaskFast sends webhooks, a Bypass app for its one path. The token is the owner's scoped
// API token. It is held in memory, sent only to api.cloudflare.com, and never logged,
// echoed or written. Run by ../provision.mjs; no relative imports, so Node runs it as is.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const API = "https://api.cloudflare.com/client/v4";
export const WEBHOOK_PATH = "/webhooks/taskfast";
export const LINK_MS = 15 * 60_000;
// The names mark the apps this command made, so a rerun without its state file finds them.
const consoleName = (host: string) => `TaskFast agent ${host}`;
const webhookName = (host: string) => `TaskFast agent ${host} webhooks`;

export class ProvisionError extends Error {}

// One Cloudflare API call. Resolves to the `result`; a refusal throws a ProvisionError
// that names the next step. The token goes in the header and nowhere else.
export type Api = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<unknown>;
export function cloudflare(token: string, fetcher: typeof fetch = fetch): Api {
  return async (method, path, body) => {
    let response: Response;
    try {
      response = await fetcher(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ProvisionError(`Could not reach Cloudflare (${method} ${path}). Check your connection and run setup again; it re-reads before creating anything.`);
    }
    const reply = (await response.json().catch(() => undefined)) as { success?: boolean; result?: unknown; errors?: { message?: string }[] } | undefined;
    if (response.ok && reply?.success) return reply.result;
    const said = reply?.errors?.map((e) => e.message).filter(Boolean).join("; ") || `HTTP ${response.status}`;
    if (response.status === 401) throw new ProvisionError(`Cloudflare did not accept this token (${said}). It may be mistyped, expired or deleted. Create a new one in API Tokens.`);
    if (response.status === 403 && path.startsWith("/accounts?")) {
      throw new ProvisionError(`Cloudflare would not list accounts with this token (${said}). Set CLOUDFLARE_ACCOUNT_ID in the shell to your account ID before running setup, or pass --account-id.`);
    }
    if (response.status === 403) {
      const needs = path.endsWith("/organizations") ? "Access: Organizations, Identity Providers, and Groups Read" : "Access: Apps and Policies Write";
      throw new ProvisionError(`This token lacks ${needs} (${said}). Edit the token in API Tokens and add it.`);
    }
    throw new ProvisionError(`Cloudflare refused ${method} ${path}: ${said}`);
  };
}

export interface Target { account: string; host: string; email: string; webhooks: boolean }
export interface App { id: string; name: string; domain: string; aud?: string; policies?: { decision?: string; include?: unknown[] }[] }
// What this command made, kept in a 0600 file for reruns and teardown. Never the token.
// Policies are inline, so deleting an app deletes its policy. `deployed` is set only after
// a deploy with these values succeeded.
export interface State { account: string; host: string; teamDomain: string; aud: string; apps: { console: string; webhook?: string }; deployed?: { teamDomain: string; aud: string } }

const EMAIL = /^[^\s@*,;<>"]+@[^\s@*,;<>"]+\.[^\s@*,;<>"]+$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/;
// Checks the form's or flags' values before any Cloudflare call. Returns the hostname.
export function checkInputs(workerUrl: unknown, email: unknown): { host: string; email: string } {
  let host = "";
  try {
    const url = new URL(String(workerUrl ?? "").trim());
    if (url.protocol === "https:" && (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash && !url.port) host = url.hostname;
  } catch { host = ""; }
  if (!HOST.test(host)) throw new ProvisionError("The Worker URL must look like https://<worker>.<subdomain>.workers.dev, with no path.");
  const address = String(email ?? "").trim();
  if (!EMAIL.test(address) || address.length > 254) throw new ProvisionError("Enter one exact email address, with no wildcards or lists.");
  return { host, email: address.toLowerCase() };
}

// Finds the one account this token reaches. More than one needs --account-id.
export async function findAccount(api: Api): Promise<string> {
  const accounts = (await api("GET", "/accounts?per_page=50")) as { id: string }[];
  if (accounts.length === 1) return accounts[0]!.id;
  throw new ProvisionError(accounts.length ? "This token reaches more than one account. Limit it to one account in API Tokens, or pass --account-id." : "This token reaches no account. Set Account Resources to your account in API Tokens.");
}

const ownerPolicy = (email: string) => ({ name: "Owner only", decision: "allow", include: [{ email: { email } }] });
const bypassPolicy = { name: "TaskFast webhooks", decision: "bypass", include: [{ everyone: {} }] };
const ownerOf = (app: App): string | undefined => {
  const [policy, ...more] = app.policies ?? [];
  const [rule, ...rules] = policy?.include ?? [];
  const email = (rule as { email?: { email?: unknown } } | undefined)?.email?.email;
  return !more.length && !rules.length && policy?.decision === "allow" && typeof email === "string" ? email.toLowerCase() : undefined;
};
const isBypass = (app: App) => app.policies?.length === 1 && app.policies[0]!.decision === "bypass";

export type Step = { kind: "ok" | "create" | "change"; text: string };
// `upToDate` holds the recorded state when Access and the deployed Worker already match.
export interface Plan { target: Target; teamDomain: string; console?: App; webhook?: App; steps: Step[]; emailDiffers?: string; upToDate?: State }

// Reads what exists and says what Create would do. Writes nothing. Refuses an app for
// this hostname that this command did not make.
export async function plan(api: Api, target: Target, state?: State): Promise<Plan> {
  const org = (await api("GET", `/accounts/${target.account}/access/organizations`)) as { auth_domain?: string } | null;
  if (!org?.auth_domain) throw new ProvisionError("This account has no Zero Trust organization yet. Open Zero Trust in the Cloudflare dashboard once to create your team, then run setup again.");
  const teamDomain = `https://${org.auth_domain}`;
  const apps: App[] = [];
  for (let page = 1; ; page++) {
    const batch = (await api("GET", `/accounts/${target.account}/access/apps?per_page=100&page=${page}`)) as App[];
    apps.push(...batch);
    if (batch.length < 100) break;
  }
  const mine = (domain: string, name: string, id?: string) => {
    const found = apps.filter((app) => app.domain === domain);
    for (const app of found) {
      if (app.id !== id && app.name !== name) throw new ProvisionError(`An Access app named "${app.name}" already covers ${domain}, and this setup did not make it. Setup leaves it alone. Delete or rename it in Zero Trust → Access → Applications, or protect a different Worker.`);
    }
    if (found.length > 1) throw new ProvisionError(`More than one Access app covers ${domain}. Delete the extra ones in Zero Trust → Access → Applications.`);
    return found[0];
  };
  const recorded = state?.host === target.host && state.account === target.account ? state : undefined;
  const site = mine(target.host, consoleName(target.host), recorded?.apps.console);
  const webhook = mine(`${target.host}${WEBHOOK_PATH}`, webhookName(target.host), recorded?.apps.webhook);
  const steps: Step[] = [{ kind: "ok", text: `Team domain ${teamDomain}` }];
  let emailDiffers: string | undefined;
  if (!site) steps.push({ kind: "create", text: `Create an Access app for ${target.host} that lets in only ${target.email}` });
  else {
    const owner = ownerOf(site);
    if (owner === target.email) steps.push({ kind: "ok", text: `${target.host} lets in only ${target.email}` });
    else {
      emailDiffers = owner ?? "a policy setup did not write";
      steps.push({ kind: "change", text: `${target.host} lets in ${emailDiffers}, not ${target.email}` });
    }
  }
  if (target.webhooks) {
    if (!webhook) steps.push({ kind: "create", text: `Let TaskFast post to ${WEBHOOK_PATH} without signing in` });
    else if (isBypass(webhook)) steps.push({ kind: "ok", text: `TaskFast can post to ${WEBHOOK_PATH}` });
    else steps.push({ kind: "change", text: `Restore the bypass on ${WEBHOOK_PATH}` });
  }
  // Skip the deploy only when the state file says this exact team domain and AUD tag went out.
  const deployed = recorded?.deployed;
  const upToDate = steps.every((s) => s.kind === "ok") && !!site?.aud && recorded?.apps.console === site.id
    && deployed?.aud === site.aud && deployed.teamDomain === teamDomain && (!target.webhooks || recorded?.apps.webhook === webhook?.id);
  steps.push(upToDate ? { kind: "ok", text: "The Worker already has this team domain and AUD tag" } : { kind: "create", text: "Deploy the Worker with this team domain and AUD tag" });
  return { target, teamDomain, ...(site ? { console: site } : {}), ...(webhook ? { webhook } : {}), steps, ...(emailDiffers ? { emailDiffers } : {}), ...(upToDate ? { upToDate: recorded } : {}) };
}

export interface Done { state: State; created: string[]; alreadySetUp: boolean }
// Makes what the plan found missing, records each app as soon as it exists, then deploys.
// A different owner email changes the policy only with `replaceEmail`. When everything
// already matches it writes, saves and deploys nothing.
export async function apply(api: Api, p: Plan, o: { replaceEmail?: boolean; save(state: State): void; deploy(vars: { teamDomain: string; aud: string }): Promise<void> }): Promise<Done> {
  const { target } = p;
  if (p.upToDate) return { state: p.upToDate, created: [], alreadySetUp: true };
  if (p.emailDiffers && !o.replaceEmail) throw new ProvisionError(`${target.host} lets in ${p.emailDiffers}. Confirm the change to ${target.email} to replace it.`);
  const base = `/accounts/${target.account}/access/apps`;
  const created: string[] = [];
  const consoleBody = { type: "self_hosted", name: consoleName(target.host), domain: target.host, policies: [ownerPolicy(target.email)] };
  let site = p.console;
  if (!site) { site = (await api("POST", base, consoleBody)) as App; created.push(`Access app ${site.id}`); }
  else if (ownerOf(site) !== target.email) { site = (await api("PUT", `${base}/${site.id}`, consoleBody)) as App; created.push(`Owner policy now ${target.email}`); }
  // The create page does not promise aud in its response; the app's GET does.
  const aud = site.aud ?? ((await api("GET", `${base}/${site.id}`)) as App).aud;
  const state: State = { account: target.account, host: target.host, teamDomain: p.teamDomain, aud: aud ?? "", apps: { console: site.id, ...(p.webhook ? { webhook: p.webhook.id } : {}) } };
  o.save(state);
  if (!aud) throw new ProvisionError(`Access app ${site.id} exists but Cloudflare returned no AUD tag. Run setup again to read it.`);
  if (target.webhooks) {
    const body = { type: "self_hosted", name: webhookName(target.host), domain: `${target.host}${WEBHOOK_PATH}`, policies: [bypassPolicy] };
    if (!p.webhook) { const app = (await api("POST", base, body)) as App; state.apps.webhook = app.id; created.push(`Webhook bypass app ${app.id}`); o.save(state); }
    else if (!isBypass(p.webhook)) { await api("PUT", `${base}/${p.webhook.id}`, body); created.push("Webhook bypass restored"); }
  }
  await o.deploy({ teamDomain: p.teamDomain, aud });
  state.deployed = { teamDomain: p.teamDomain, aud };
  o.save(state);
  return { state, created, alreadySetUp: false };
}

// Deletes only the apps the state file names, after checking each still covers its host.
export async function teardown(api: Api, state: State): Promise<{ deleted: string[]; kept: string[] }> {
  const deleted: string[] = [], kept: string[] = [];
  const base = `/accounts/${state.account}/access/apps`;
  for (const [id, domain] of [[state.apps.console, state.host], [state.apps.webhook, `${state.host}${WEBHOOK_PATH}`]] as const) {
    if (!id) continue;
    let app: App | undefined;
    try { app = (await api("GET", `${base}/${id}`)) as App; } catch { app = undefined; }
    if (app?.domain !== domain) { kept.push(`${id} (not found, or no longer covers ${domain})`); continue; }
    await api("DELETE", `${base}/${id}`);
    deleted.push(id);
  }
  return { deleted, kept };
}

// The plan as the page and the CLI show it: no token, no raw API objects.
export const view = (p: Plan) => ({ host: p.target.host, email: p.target.email, teamDomain: p.teamDomain, steps: p.steps, emailDiffers: p.emailDiffers ?? null });

// What both entry points need besides their inputs.
interface Hooks {
  state(): State | undefined;
  save(state: State): void;
  deploy(vars: { teamDomain: string; aud: string }): Promise<void>;
  // Refuses a hostname that is not the Worker this folder deploys.
  checkHost?(host: string): void;
}

// The flags path: the same checkInputs, plan and apply as the form, printed instead of served.
export async function scripted(o: Hooks & {
  workerUrl: unknown; email: unknown; webhooks: boolean; dryRun: boolean; replaceEmail: boolean;
  connect(): Promise<{ api: Api; account: string }>; log(line: string): void;
}): Promise<Done | undefined> {
  const { host, email } = checkInputs(o.workerUrl, o.email);
  o.checkHost?.(host);
  const { api, account } = await o.connect();
  const p = await plan(api, { account, host, email, webhooks: o.webhooks }, o.state());
  o.log(`Account ${account}, Worker ${host}, team ${p.teamDomain}`);
  for (const step of p.steps) o.log(`  ${step.kind.padEnd(6)} ${step.text}`);
  if (o.dryRun) return undefined;
  const done = await apply(api, p, { replaceEmail: o.replaceEmail, save: o.save, deploy: o.deploy });
  if (done.alreadySetUp) o.log("Already set up: nothing changed.");
  for (const line of done.created) o.log(`made: ${line}`);
  o.log(`Access app ${done.state.apps.console}, AUD ${done.state.aud}`);
  o.log(`Who is allowed in: Zero Trust → Access → Applications → ${consoleName(host)} → Policies. Run again with --replace-email to change it.`);
  return done;
}

// ---- The local form. Same protections as the local console in src/console.ts (copied,
// because the kit's host code and this package never import each other).
const PAGE_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MAX_BODY = 16 * 1024;
function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  res.writeHead(status, {
    "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    ...(type === "text/html" ? { "content-security-policy": PAGE_POLICY } : {}),
  });
  res.end(type === "application/json" ? JSON.stringify(body) : String(body));
}
function sameToken(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch { return undefined; }
}

export interface FormOptions extends Hooks {
  page: string;
  // Builds the API client for the token the owner pasted, and finds the account.
  connect(token: string): Promise<{ api: Api; account: string }>;
  linkMs?: number;
}
export type FormEnd = "created" | "already set up" | "expired";
// Serves the setup page on 127.0.0.1 behind a one-time link token. `done` resolves when
// setup succeeds or the link expires; the server is closed by then.
export async function startForm(o: FormOptions): Promise<{ url: string; port: number; done: Promise<FormEnd>; close(): Promise<void> }> {
  const link = randomBytes(32).toString("hex");
  let port = 0;
  let secret: string | undefined;
  let checked: { api: Api; plan: Plan } | undefined;
  let busy = false;
  let finish!: (how: FormEnd) => void;
  const done = new Promise<FormEnd>((resolve) => { finish = resolve; });
  // Defense in depth: a message from anywhere never carries the pasted token.
  const clean = (message: string) => (secret ? message.split(secret).join("[token]") : message);
  const own = () => [`127.0.0.1:${port}`, `localhost:${port}`];
  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
    try {
      if (!own().includes(req.headers.host ?? "")) return send(res, 403, { error: "unknown host" });
      if (req.method === "OPTIONS") return send(res, 405, { error: "no cross-origin requests" });
      if (req.headers.origin !== undefined && !own().some((host) => req.headers.origin === `http://${host}`)) return send(res, 403, { error: "unknown origin" });
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path === "/") return send(res, 200, o.page, "text/html");
      // The bearer header is the CSRF check too: another site's form cannot set it.
      if (!sameToken(req.headers.authorization, link)) return send(res, 401, { error: "This setup link is missing its token or has expired. Run setup again for a new link." });
      if (req.method !== "POST" || (path !== "/api/check" && path !== "/api/create")) return send(res, 404, { error: "not found" });
      if (busy) return send(res, 409, { error: "Setup is already running. Wait for it to finish." });
      busy = true;
      try {
        const body = await readJson(req);
        if (!body) return send(res, 400, { error: "The request was not readable. Reload the page and try again." });
        if (path === "/api/check") {
          const { host, email } = checkInputs(body.workerUrl, body.email);
          o.checkHost?.(host);
          if (typeof body.token === "string" && body.token.trim()) secret = body.token.trim();
          if (!secret) throw new ProvisionError("Paste your scoped API token.");
          const { api, account } = await o.connect(secret);
          const p = await plan(api, { account, host, email, webhooks: body.webhooks === true }, o.state());
          checked = { api, plan: p };
          return send(res, 200, view(p));
        }
        if (!checked) return send(res, 409, { error: "Check the details first." });
        const result = await apply(checked.api, checked.plan, { replaceEmail: body.replaceEmail === true, save: o.save, deploy: o.deploy });
        send(res, 200, { appName: consoleName(result.state.host), alreadySetUp: result.alreadySetUp, created: result.created, app: result.state.apps.console, aud: result.state.aud, teamDomain: result.state.teamDomain, host: result.state.host });
        secret = undefined;
        checked = undefined;
        setImmediate(() => finish(result.alreadySetUp ? "already set up" : "created"));
      } finally { busy = false; }
    } catch (error) {
      if (!res.headersSent) send(res, error instanceof ProvisionError ? 422 : 500, { error: clean(error instanceof ProvisionError ? error.message : "Setup failed unexpectedly. Nothing after the last step shown ran; run setup again.") });
    }
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
  const timer = setTimeout(() => finish("expired"), o.linkMs ?? LINK_MS);
  const close = () => new Promise<void>((resolve) => { clearTimeout(timer); secret = undefined; server.closeAllConnections(); server.close(() => resolve()); });
  done.then(close, close);
  return { url: `http://127.0.0.1:${port}/#token=${link}`, port, done, close };
}
