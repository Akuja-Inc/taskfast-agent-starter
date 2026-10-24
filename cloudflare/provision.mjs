// Puts this Worker behind Cloudflare Access with the owner's scoped API token (#144).
//   node provision.mjs                      opens the local setup page (127.0.0.1 only)
//   node provision.mjs --worker-url <url> --email <addr> [--webhooks] [--dry-run] [--replace-email]
//   node provision.mjs --teardown           deletes only the Access apps .access.json records
// Scripted runs read the token from CLOUDFLARE_ACCESS_TOKEN, never CLOUDFLARE_API_TOKEN,
// which Wrangler would use in place of its own login. The token is never printed or saved.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { apply, checkInputs, cloudflare, findAccount, plan, ProvisionError, startForm, teardown, view } from "./src/provision.ts";

const HERE = import.meta.dirname;
const STATE = join(HERE, ".access.json");
const CONFIG = join(HERE, "wrangler.jsonc");
const { values: flags } = parseArgs({
  strict: true,
  options: {
    "worker-url": { type: "string" }, email: { type: "string" }, "account-id": { type: "string" },
    webhooks: { type: "boolean" }, "dry-run": { type: "boolean" }, "replace-email": { type: "boolean" }, teardown: { type: "boolean" }, help: { type: "boolean", short: "h" },
  },
});
if (flags.help) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 6).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}

const readState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : undefined);
const save = (state) => {
  writeFileSync(`${STATE}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(`${STATE}.tmp`, 0o600);
  renameSync(`${STATE}.tmp`, STATE);
};
// wrangler.jsonc holds only whole-line // comments; this reads it without a JSONC parser.
const config = () => JSON.parse(readFileSync(CONFIG, "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"));
// Wrangler runs with the owner's own login: this token never reaches it.
const { CLOUDFLARE_ACCESS_TOKEN: _token, ...wranglerEnv } = process.env;
async function deploy({ teamDomain, aud }) {
  // Keep the values in wrangler.jsonc so every later deploy keeps them too.
  let text = readFileSync(CONFIG, "utf8");
  for (const [key, value] of [["ACCESS_TEAM_DOMAIN", teamDomain], ["ACCESS_AUD", aud]]) {
    const pattern = new RegExp(`("${key}"\\s*:\\s*)"[^"\\n]*"`);
    if (!pattern.test(text)) throw new ProvisionError(`wrangler.jsonc has no "${key}" var. Add it under "vars", then run setup again.`);
    text = text.replace(pattern, `$1${JSON.stringify(value)}`);
  }
  writeFileSync(CONFIG, text);
  const wrangler = join(HERE, "node_modules", ".bin", "wrangler");
  const run = spawnSync(wrangler, ["deploy", "--containers-rollout=none"], { cwd: HERE, env: wranglerEnv, stdio: ["ignore", "inherit", "inherit"] });
  if (run.status !== 0) throw new ProvisionError("Access is set up and wrangler.jsonc has its values, but wrangler deploy failed (see the terminal). Run `pnpm exec wrangler deploy` from cloudflare/ once it is fixed.");
}
// The Worker this hostname names must be the one wrangler.jsonc deploys.
function sameWorker(host) {
  const name = config().name;
  if (host.split(".")[0] !== name) throw new ProvisionError(`${host} is not the Worker wrangler.jsonc deploys ("${name}"). Use https://${name}.<your subdomain>.workers.dev.`);
}
async function connect(token) {
  const api = cloudflare(token);
  return { api, account: flags["account-id"] ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? (await findAccount(api)) };
}

try {
  if (flags.teardown) {
    const state = readState();
    if (!state) throw new ProvisionError("No .access.json here, so there is nothing this setup made to delete.");
    const token = process.env.CLOUDFLARE_ACCESS_TOKEN;
    if (!token) throw new ProvisionError("Set CLOUDFLARE_ACCESS_TOKEN to the scoped token in this shell, without echoing it, then run teardown again.");
    const { deleted, kept } = await teardown(cloudflare(token), state);
    for (const id of deleted) console.log(`deleted Access app ${id}`);
    for (const line of kept) console.log(`not deleted: ${line}`);
    if (!kept.length) rmSync(STATE);
    process.exit(kept.length ? 1 : 0);
  }
  if (flags["worker-url"] !== undefined || flags.email !== undefined) {
    const { host, email } = checkInputs(flags["worker-url"], flags.email);
    sameWorker(host);
    const token = process.env.CLOUDFLARE_ACCESS_TOKEN;
    if (!token) throw new ProvisionError("Set CLOUDFLARE_ACCESS_TOKEN to the scoped token in this shell, without echoing it, or run without flags to use the setup page.");
    const { api, account } = await connect(token);
    const p = await plan(api, { account, host, email, webhooks: flags.webhooks === true }, readState());
    const shown = view(p);
    console.log(`Account ${account}, Worker ${shown.host}, team ${shown.teamDomain}`);
    for (const step of shown.steps) console.log(`  ${step.kind.padEnd(6)} ${step.text}`);
    if (flags["dry-run"]) process.exit(0);
    const done = await apply(api, p, { replaceEmail: flags["replace-email"] === true, save, deploy });
    for (const line of done.created) console.log(`made: ${line}`);
    console.log(`Access app ${done.state.apps.console}, AUD ${done.state.aud}`);
    process.exit(0);
  }
  const env = config().vars?.CLI_ENV ?? "";
  const page = readFileSync(join(HERE, "provision-page.html"), "utf8").replace("<head>", `<head>\n<meta name="taskfast-env" content="${/^[a-z]+$/.test(env) ? env : ""}">`);
  const form = await startForm({
    page, state: readState, save, checkHost: sameWorker,
    connect: async (token) => connect(token),
    deploy: async (vars) => deploy(vars),
  });
  console.log(`Open this link to protect your agent (this computer only, for 15 minutes):\n  ${form.url}`);
  const how = await form.done;
  console.log(how === "created" ? "Access is set up. Setup has stopped." : "The setup link expired. Run setup again for a new one.");
} catch (error) {
  const said = error instanceof ProvisionError ? error.message : `Setup failed unexpectedly: ${error?.name}: ${error?.message}`;
  console.error(_token ? said.split(_token).join("[token]") : said);
  process.exit(1);
}
