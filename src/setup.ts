import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import input from "@inquirer/input";
import password from "@inquirer/password";
import { createAgentModels, providerSource } from "./core/model.js";
import { credentialSetting, folderFile, PASSWORD_PATH, WALLET_PATH } from "./core/folder.js";
import { loadSkills, SKILLS_PATH } from "./core/skills.js";
import { agentFile, INSTRUCTIONS_PATH, parseAgentFile, parseAgentSpec } from "./core/spec.js";
import type { Role } from "./core/types.js";
import { ENVIRONMENTS, taskfastEnv, type Environment } from "./run.js";

// One entry of the catalogue generated from the installed pi-ai pin.
export interface Provider {
  id: string;
  package: string;
  export: string;
  nativeId: string;
  // All choices share the already installed pi-ai package pin.
  version: string;
  label: string;
  settings: { name: string; required: boolean; description: string }[];
  // Tool-calling text models in pinned catalog order.
  models: string[];
  defaultModel: string;
  // Each group is an alternative to the default required settings.
  authAlternatives: string[][];
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
function isProvider(value: unknown): value is Provider {
  if (!isRecord(value)) return false;
  return [value.id, value.nativeId, value.package, value.export, value.version, value.label, value.defaultModel].every((item) => typeof item === "string")
    && (value.note === undefined || typeof value.note === "string")
    && isStringArray(value.models)
    && Array.isArray(value.authAlternatives) && value.authAlternatives.every(isStringArray)
    && Array.isArray(value.settings) && value.settings.every((setting: unknown) => isRecord(setting) && typeof setting.name === "string" && typeof setting.required === "boolean" && typeof setting.description === "string");
}
export function readCatalogue(root: string): Provider[] {
  const value: unknown = JSON.parse(readFileSync(join(root, "providers.json"), "utf8"));
  if (!isRecord(value) || !Array.isArray(value.providers) || !value.providers.every(isProvider)) throw new Error("Invalid providers.json; regenerate it from the installed pi-ai pin");
  const providers = value.providers;
  for (const provider of providers) {
    const source = providerSource(provider.id);
    if (source.package !== provider.package || source.export !== provider.export || source.version !== provider.version || source.nativeId !== provider.nativeId) throw new Error("providers.json does not match the generated provider table");
  }
  return providers;
}

// Every answer can be passed as a flag instead; whatever is not passed is asked, except
// env, which is production unless passed.
export interface SetupOptions {
  env?: string;
  provider?: string;
  // NAME=value, or NAME alone to take the value from the environment variable NAME.
  set?: string[];
  model?: string;
  agent?: string;
  role?: string;
  name?: string;
  business?: string;
  description?: string;
  goals?: string;
  budget?: string;
  // The name of an environment variable holding the new wallet's password.
  walletPasswordEnv?: string;
  init?: boolean;
  // Add the taskfast CLI's own taskfast-agent skill to the new agent folder.
  taskfastSkill?: boolean;
}

export const USAGE = `Usage: pnpm setup-agent [options]

Sets up a model provider and one agent. Anything you leave out is asked.

  --env production|staging|development
                          Where the agent's TaskFast account lives (default: production).
                          development is a TaskFast server on this machine (127.0.0.1:4000).
  --provider <id>         Model provider, e.g. anthropic, openai, moonshotai, openrouter,
                          ollama; supported installed providers only (see providers.json)
                          Setup never installs packages. Auth notes: docs/providers.md
  --set NAME=value        A provider setting for .env, e.g. --set ANTHROPIC_API_KEY=sk-...
                          Repeat for each setting. --set NAME takes the value from your
                          environment, which keeps it out of your shell history.
  --model <id>            Model id, e.g. claude-sonnet-4-6
  --agent <folder>        Agent folder under agents/ (lowercase letters, digits, dashes)
  --role worker|poster|both
  --name <text>           Your name, as the agent signs it
  --business <text>       Business name
  --description <text>    What the business does, in one sentence
  --goals <text>          What the agent should aim for
  --budget <usd>          Budget per job, for a poster or both-sides agent
  --wallet-password-env NAME
                          Write the wallet password from environment variable NAME to
                          .taskfast/wallet-password (at least 12 characters). Asked only
                          when setup asks about init.
  --init / --no-init      Run taskfast init for the agent now, or skip it
  --taskfast-skill        Add the taskfast CLI's taskfast-agent skill to the agent's
                          .agents/skills folder, with the CLI version and file hashes
  -h, --help              Show this help`;

// The example folder each role starts from, and its suggested goals. Setup copies the
// example's agent.json and writes INSTRUCTIONS.md from the user's answers.
const EXAMPLE: Record<Role, { folder: string; goals: string }> = {
  worker: { folder: "careful-worker", goals: "do a few jobs very well and earn repeat clients" },
  poster: { folder: "brisk-poster", goals: "get small jobs done fast at a fair price" },
  both: { folder: "both-sides", goals: "take writing work, and hire help with research when busy" },
};

// The INSTRUCTIONS.md setup writes: the user's answers as plain sentences they can edit later.
export function instructionsText(c: { name: string; business: string; description: string; goals: string; budgetUsd?: number }): string {
  return [
    `You are ${c.name}, who runs ${c.business}. ${c.description}`,
    `What you want right now: ${c.goals}.`,
    ...(c.budgetUsd === undefined ? [] : [`You have about $${c.budgetUsd} to spend on a single job.`]),
  ].join("\n\n") + "\n";
}
const ROLES: Record<Role, string> = { worker: "Take jobs (worker)", poster: "Post jobs (poster)", both: "Both" };

// How many models the menu lists; any other id can be typed.
const SHOWN = 15;

export interface SetupIO {
  root: string;
  env: NodeJS.ProcessEnv;
  // Trims answers, except hidden ones, which are returned as typed.
  ask(question: string, hidden?: boolean): Promise<string>;
  // Runs a command with the terminal attached and the given environment; returns its exit status.
  run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): number;
  // Runs a command without the terminal; returns its exit status and stdout.
  capture(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): { status: number; stdout: string };
  log(line: string): void;
}

const VALUE = /^[^\s#"'`\\]+$/;
const SETTING = /^[A-Z][A-Z0-9_]*$/;
const FOLDER = /^[a-z0-9][a-z0-9-]*$/;

// Sets KEY=value in .env text, replacing an existing KEY line.
export function upsertEnv(text: string, key: string, value: string): string {
  if (!VALUE.test(value)) throw new Error("the value must not contain spaces, quotes, backslashes or #");
  const lines = text.split("\n").filter((l, i, all) => l !== "" || i < all.length - 1);
  const at = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (at >= 0) lines[at] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  return `${lines.join("\n")}\n`;
}

// Read the installed shared package's manifest without requiring its import-only
// entrypoint. This is informational; setup never installs or replaces packages.
export function installedVersion(root: string, pkg: string): string | null {
  if (!/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(pkg)) return null;
  const file = join(root, "node_modules", ...pkg.split("/"), "package.json");
  if (!existsSync(file)) return null;
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  return isRecord(value) && value.name === pkg && typeof value.version === "string" ? value.version : null;
}

// A setting whose value is a credential is masked while typing.
const secret = (name: string) => /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/.test(name);

// The CLI itself accepts any one-line password; the minimum is this kit's own.
const MIN_PASSWORD = 12;
const passwordProblem = (v: string) => (!v ? "is not set in your environment" : /[\r\n]/.test(v) ? "must be one line" : [...v].length < MIN_PASSWORD ? `must be at least ${MIN_PASSWORD} characters` : null);

const agentProblem = (root: string, v: string) => {
  if (!FOLDER.test(v)) return "use lowercase letters, digits and dashes";
  const taken = ["agent.json", INSTRUCTIONS_PATH].find((file) => existsSync(join(root, "agents", v, file)));
  return taken ? `agents/${v} already has an ${taken}; pick another name` : null;
};

const SKILL = "taskfast-agent";
type Bundle = { version: string; files: Map<string, string> };
// The CLI's embedded skill, exported into a throwaway folder that is also its home, with
// no config or key, so it reads no account; then checked as the agent will load it.
function exportTaskfastSkill(io: SetupIO, cliEnv: string): Bundle {
  const tmp = mkdtempSync(join(tmpdir(), "taskfast-skill-"));
  try {
    const env = { PATH: io.env.PATH ?? "", HOME: tmp };
    const version = /^taskfast (\S+)\s*$/.exec(io.capture("taskfast", ["--version"], tmp, env).stdout)?.[1];
    const args = [...(cliEnv === "prod" ? [] : ["--env", cliEnv]), `--config=${join(tmp, "absent.json")}`, "--no-trace", "skills", "--yes"];
    if (!version || io.capture("taskfast", args, tmp, env).status !== 0) {
      throw new Error("taskfast skills did not finish; install the taskfast CLI, or run setup without --taskfast-skill");
    }
    const skills = loadSkills(tmp);
    if (skills.length !== 1 || skills[0]!.name !== SKILL) throw new Error(`taskfast skills exported ${skills.map((skill) => skill.name).join(", ") || "no skill"}, not ${SKILL}`);
    return { version, files: skills[0]!.files };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
// Writes the checked files beside the skills folder, records where they came from, then
// renames them into place, so a skill folder is never half written.
function publishSkill(dir: string, bundle: Bundle): void {
  mkdirSync(join(dir, SKILLS_PATH), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dir, ".agents", `.${SKILL}-`));
  const files: Record<string, string> = {};
  for (const [path, text] of [...bundle.files].sort(([a], [b]) => a.localeCompare(b))) {
    mkdirSync(dirname(join(staging, path)), { recursive: true });
    writeFileSync(join(staging, path), text);
    files[path] = createHash("sha256").update(text).digest("hex");
  }
  writeFileSync(join(dir, ".agents", "provenance.json"), `${JSON.stringify({ [SKILL]: { source: "taskfast-cli", version: bundle.version, files } }, null, 2)}\n`);
  renameSync(staging, join(dir, SKILLS_PATH, SKILL));
}

// Checks every flag before setup changes anything, so a typo cannot leave a half-done
// setup. Returns the --set values by name.
function checkOptions({ options: o, io, catalogue }: { options: SetupOptions; io: SetupIO; catalogue: Provider[] }): Map<string, string> {
  const problems: string[] = [];
  const bad = (flag: string, why: string) => problems.push(`--${flag}: ${why}`);
  if (o.env !== undefined && !Object.hasOwn(ENVIRONMENTS, o.env)) bad("env", `use production, staging or development, not ${JSON.stringify(o.env)}`);
  if (o.provider !== undefined) {
    if (!/^[a-z0-9-]+$/.test(o.provider)) bad("provider", "use the provider id, lowercase letters, digits and dashes");
    else if (!catalogue.some((p) => p.id === o.provider)) bad("provider", `unsupported provider ${JSON.stringify(o.provider)}; see docs/providers.md`);
  }
  const set = new Map<string, string>();
  for (const s of o.set ?? []) {
    const at = s.indexOf("=");
    const name = at < 0 ? s : s.slice(0, at);
    const value = at < 0 ? io.env[name] : s.slice(at + 1);
    if (!SETTING.test(name)) bad("set", `${JSON.stringify(name)} is not a setting name such as ANTHROPIC_API_KEY`);
    else if (value === undefined || value === "") bad("set", at < 0 ? `${name} is not set in your environment` : `${name} has no value`);
    else if (!VALUE.test(value)) bad("set", `${name}'s value has spaces, quotes, backslashes or #`);
    else set.set(name, value);
  }
  if (o.model !== undefined && !/^\S+$/.test(o.model)) bad("model", "a model id has no spaces");
  if (o.agent !== undefined) {
    const p = agentProblem(io.root, o.agent);
    if (p) bad("agent", p);
  }
  if (o.role !== undefined && !Object.hasOwn(ROLES, o.role)) bad("role", "use worker, poster or both");
  for (const f of ["name", "business", "description", "goals"] as const) if (o[f] !== undefined && !o[f].trim()) bad(f, "it is empty");
  if (o.budget !== undefined) {
    if (!(Number(o.budget) > 0) || !Number.isFinite(Number(o.budget))) bad("budget", "enter a positive number of USD");
    else if (o.role === "worker") bad("budget", "a worker has no budget; it applies to poster and both");
  }
  if (o.walletPasswordEnv !== undefined) {
    const p = passwordProblem(io.env[o.walletPasswordEnv] ?? "");
    if (p) bad("wallet-password-env", `${o.walletPasswordEnv}: ${p}`);
  }
  const selected = catalogue.find((p) => p.id === o.provider);
  if (selected) for (const name of set.keys()) {
    if (!selected.settings.some((s) => s.name === name)) bad("set", `${name} is not a setting for ${selected.id}; see docs/providers.md`);
  }
  if (problems.length) throw new Error(`check these options:\n  ${problems.join("\n  ")}\n\n${USAGE}`);
  return set;
}

// A numbered menu; an answer may also be one of the options' keys (a provider id).
async function choose<T>(io: SetupIO, question: string, options: readonly T[], label: (o: T) => string, fallback = 0, key?: (o: T) => string): Promise<T> {
  io.log(question);
  options.forEach((o, i) => io.log(`  ${String(i + 1).padStart(2)}. ${label(o)}`));
  for (;;) {
    const a = (await io.ask(`Choose 1-${options.length}${key ? " or type a name" : ""} [${fallback + 1}]: `)) || String(fallback + 1);
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!;
    const named = key && options.find((o) => key(o) === a);
    if (named) return named;
    io.log(`Enter a number from 1 to ${options.length}.`);
  }
}

async function text(io: SetupIO, question: string, fallback = "", check: (v: string) => string | null = () => null, hidden = false): Promise<string> {
  for (;;) {
    const v = (await io.ask(fallback ? `${question} [${fallback}]: ` : `${question}: `, hidden)).trim() || fallback;
    const problem = v ? check(v) : "an answer is needed";
    if (!problem) return v;
    io.log(problem);
  }
}

// The model: a pinned catalogue entry by number, or a supported id typed out.
async function pickModel(io: SetupIO, p: Provider): Promise<string> {
  const shown = p.models.slice(0, SHOWN);
  if (shown.length) {
    io.log(`\nModels on ${p.label}, in pinned catalog order:`);
    shown.forEach((m, i) => io.log(`  ${String(i + 1).padStart(2)}. ${m}${m === p.defaultModel ? "  (suggested)" : ""}`));
    if (p.models.length > shown.length) io.log(`  ... and ${p.models.length - shown.length} more in providers.json; type any of them.`);
  }
  for (;;) {
    const a = (await io.ask(`Model${shown.length ? `: a number, or type a model id` : " id"}${p.defaultModel ? ` [${p.defaultModel}]` : ""}: `)) || p.defaultModel;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= shown.length) return shown[n - 1]!;
    if (a && /^\S+$/.test(a) && !/^\d+$/.test(a)) return a;
    io.log(a ? "Enter a listed number or a model id without spaces." : "A model id is needed.");
  }
}

// Sets up an installed provider's settings and one agent: writes .env and
// agents/<id>/agent.json and INSTRUCTIONS.md, then runs taskfast init. No package installation. Values
// passed in `o` are used as given; the rest are asked.
export async function setup(io: SetupIO, o: SetupOptions = {}): Promise<void> {
  const catalogue = readCatalogue(io.root);
  const set = checkOptions({ options: o, io, catalogue });
  const environment = (o.env ?? "production") as Environment;
  io.log("TaskFast agent setup. Press Enter to take the value in [brackets].");
  io.log(`Environment: ${environment}${o.env ? "" : " (pass --env staging or --env development to change it)"}\n`);

  // 1. Only explicit, generated provider choices. Check flagged models before
  // settings are saved; construction uses native catalogs without network calls.
  const provider = o.provider ? catalogue.find((p) => p.id === o.provider) : await choose(io, "Which model provider will your agent use?", catalogue, (p) => p.label, 0, (p) => p.id);
  if (!provider) throw new Error("unsupported provider; see docs/providers.md");
  for (const name of set.keys()) if (!provider.settings.some((s) => s.name === name)) throw new Error(`--set: ${name} is not a setting for ${provider.id}; see docs/providers.md`);
  if (o.model !== undefined) await createAgentModels(`${provider.id}:${o.model}`);
  if (provider.note) io.log(`\nNote: ${provider.note}`);

  // Select the owning folder before collecting private settings. Nothing is
  // written until the full agent file has been validated.
  const id = o.agent ?? (await text(io, "\nAgent folder name (agents/<name>)", "my-agent", (v) => agentProblem(io.root, v)));
  const dir = join(io.root, "agents", id);
  // Each agent keeps its own provider settings; never read the repository's .env.
  const envPath = folderFile({ agentDir: dir, path: ".env", resource: "provider settings" });
  for (const path of ["agent.json", INSTRUCTIONS_PATH, ".taskfast/config.json", WALLET_PATH]) folderFile({ agentDir: dir, path, resource: "agent resource" });
  const passwordPath = folderFile({ agentDir: dir, path: PASSWORD_PATH, resource: "agent resource" });
  // Owner edits win: an existing skill is never replaced. Export and check before any write.
  if (o.taskfastSkill && existsSync(folderFile({ agentDir: dir, path: `${SKILLS_PATH}/${SKILL}`, resource: "agent resource" }))) {
    throw new Error(`agents/${id}/${SKILLS_PATH}/${SKILL} already exists; setup never replaces a skill`);
  }
  const bundle = o.taskfastSkill ? exportTaskfastSkill(io, taskfastEnv(environment)) : undefined;
  let envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const save = (name: string, value: string) => {
    envText = upsertEnv(envText, name, credentialSetting({ agentDir: dir, name, value }));
    io.log(`Collected ${name} for agents/${id}/.env`);
  };
  // Required shell settings are saved to this agent's private settings so the
  // stopped folder remains self-contained.
  const available = (name: string) => set.get(name) ?? envText.split("\n").find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1) ?? io.env[name];
  const defaults = provider.settings.filter((s) => s.required).map((s) => s.name);
  const groups = [defaults, ...provider.authAlternatives];
  const complete = groups.find((group) => group.every((name) => available(name)));
  // A partial explicitly supplied alternative chooses its path (e.g. AWS keys),
  // rather than prompting for an unrelated bearer token or cloud API key.
  const required = complete ?? groups.find((group) => group.some((name) => !defaults.includes(name) && available(name))) ?? defaults;
  if (provider.nativeId === "google-vertex" && !required.includes("GOOGLE_CLOUD_API_KEY")) {
    const path = available("GOOGLE_APPLICATION_CREDENTIALS") ?? ".config/gcloud/application_default_credentials.json";
    const local = credentialSetting({ agentDir: dir, name: "GOOGLE_APPLICATION_CREDENTIALS", value: path });
    if (!existsSync(resolve(dir, local))) throw new Error("Vertex ADC needs an existing credentials file inside the agent folder; place it there and pass --set GOOGLE_APPLICATION_CREDENTIALS");
    save("GOOGLE_APPLICATION_CREDENTIALS", local);
  }
  for (const [name, value] of set) save(name, value);
  for (const s of provider.settings.filter((s) => required.includes(s.name) && !set.has(s.name))) {
    if (envText.split("\n").some((l) => l.startsWith(`${s.name}=`) && l.length > s.name.length + 1)) {
      io.log(`Using ${s.name} already in .env (pass --set ${s.name}=... to replace it)`);
      continue;
    }
    const value = available(s.name);
    if (value) {
      save(s.name, value);
      continue;
    }
    const what = s.description ? ` (${s.description})` : "";
    save(s.name, await text(io, `\n${secret(s.name) ? "Paste" : "Enter"} your ${s.name}${what}${secret(s.name) ? ", input is masked; press Enter to continue" : ""}`, "", (v) => (VALUE.test(v) ? null : "that value has spaces, quotes, backslashes or #"), secret(s.name)));
  }
  const optional = provider.settings.filter((s) => !s.required && !set.has(s.name)).map((s) => s.name);
  if (optional.length) io.log(`\nOptional settings, if you need them, go in .env too (or pass --set): ${optional.join(", ")}`);
  let model: string;
  for (;;) {
    model = `${provider.id}:${o.model ?? (await pickModel(io, provider))}`;
    try {
      await createAgentModels(model);
      break;
    } catch (error) {
      if (o.model !== undefined) throw error;
      io.log(error instanceof Error ? error.message : "unsupported model");
    }
  }

  // 3. The agent.
  const role = (o.role as Role | undefined) ?? (await choose(io, "\nWhat will it do on TaskFast?", Object.keys(ROLES) as Role[], (r) => ROLES[r]));
  if (o.budget !== undefined && role === "worker") throw new Error("--budget: a worker has no budget; it applies to poster and both");
  const example = parseAgentFile(JSON.parse(readFileSync(join(io.root, "examples", EXAMPLE[role].folder, "agent.json"), "utf8")));
  const answers = {
    name: o.name ?? (await text(io, "Your name, as the agent signs it")),
    business: o.business ?? (await text(io, "Business name")),
    description: o.description ?? (await text(io, "What the business does, in one sentence")),
    goals: o.goals ?? (await text(io, "What the agent should aim for", EXAMPLE[role].goals)),
    ...(role === "worker" ? {} : { budgetUsd: Number(o.budget ?? (await text(io, "Budget per job in USD", String(example.limits?.perJobUsd ?? 20), (v) => (Number(v) > 0 && Number.isFinite(Number(v)) ? null : "enter a positive number")))) }),
  };
  const spec = parseAgentSpec({ ...example, role, model, instructions: instructionsText(answers) });
  const settings: Record<string, string> = {};
  for (const [name, value] of Object.entries(parseEnv(envText))) if (typeof value === "string") settings[name] = value;
  await createAgentModels(model, { agentDir: dir, settings });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (envText) {
    writeFileSync(envPath, envText, { mode: 0o600 });
    chmodSync(envPath, 0o600);
  }
  writeFileSync(join(dir, "agent.json"), `${JSON.stringify(agentFile(spec), null, 2)}\n`);
  writeFileSync(join(dir, INSTRUCTIONS_PATH), spec.instructions);
  io.log(`\nWrote agents/${id}/${INSTRUCTIONS_PATH} from your answers; edit it any time to change who the agent is and what it wants.`);
  io.log(`Wrote agents/${id}/agent.json (dials, temperament and limits come from examples/${EXAMPLE[role].folder}; edit them there any time).`);
  if (bundle) {
    publishSkill(dir, bundle);
    io.log(`Added the ${SKILL} skill from taskfast ${bundle.version} to agents/${id}/${SKILLS_PATH} (file hashes in .agents/provenance.json)`);
  }

  // 4. The agent's TaskFast account, in the environment given by --env.
  const cliEnv = taskfastEnv(environment);
  const initArgs = [...(cliEnv === "prod" ? [] : ["--env", cliEnv]), "init", `--keystore-path=${WALLET_PATH}`];
  const initCmd = `taskfast ${initArgs.join(" ")}`;
  const ran = o.init ?? !/^n/i.test(await io.ask(`\nRun \`${initCmd}\` in agents/${id} now? It signs the agent up on ${environment} and sets up its wallet. [Y/n]: `));
  // An existing file may already encrypt a wallet, so it is never replaced.
  if (existsSync(passwordPath)) io.log(`Using the wallet password already in agents/${id}/${PASSWORD_PATH}`);
  else {
    // Only an interactive init asks, so a run answered entirely by flags never prompts.
    let value = o.walletPasswordEnv === undefined ? (ran && o.init === undefined ? undefined : "") : io.env[o.walletPasswordEnv];
    while (value === undefined) {
      // Untrimmed: the CLI keeps spaces, so the file holds exactly what was typed.
      const v = await io.ask(`Wallet password for signing posts, escrow and settlement, at least ${MIN_PASSWORD} characters (input is masked; press Enter to skip): `, true);
      const p = v ? passwordProblem(v) : null;
      if (p) io.log(`The password ${p}.`);
      else if (!v || (await io.ask("Confirm the wallet password: ", true)) === v) value = v;
      else io.log("The passwords did not match. Enter it again.");
    }
    if (value) {
      mkdirSync(join(dir, ".taskfast"), { recursive: true, mode: 0o700 });
      writeFileSync(passwordPath, value, { mode: 0o400, flag: "wx" });
      chmodSync(passwordPath, 0o400);
      io.log(`Wrote agents/${id}/${PASSWORD_PATH}`);
    }
  }
  if (existsSync(passwordPath)) {
    // Generating here keeps init from asking for its own password, which would win over the file.
    if (!existsSync(join(dir, WALLET_PATH)) && !existsSync(join(dir, ".taskfast/config.json"))) initArgs.push("--generate-wallet");
    initArgs.push(`--wallet-password-file=${PASSWORD_PATH}`);
  }
  // The CLI prefers TASKFAST_WALLET_PASSWORD to the password file, but the host never
  // passes it, so init must not see it either: a wallet encrypted with it could not be
  // unlocked when the agent signs. Pass --wallet-password-env TASKFAST_WALLET_PASSWORD to use its value.
  const { TASKFAST_WALLET_PASSWORD: shellPassword, ...initEnv } = io.env;
  if (ran && shellPassword) io.log(`taskfast init runs without TASKFAST_WALLET_PASSWORD, so the wallet uses agents/${id}/${PASSWORD_PATH} as the agent does.`);
  const status = ran ? io.run("taskfast", initArgs, dir, initEnv) : -1;
  if (status !== 0) io.log(`\n${ran ? "taskfast init did not finish. " : ""}Run it yourself when ready:\n  cd agents/${id} && taskfast ${initArgs.join(" ")}`);

  io.log(`\nNext:\n  pnpm agents --env ${environment}`);
}

// Reads setup's command-line flags; throws on an unknown flag.
export function parseSetupArgs(argv: string[]): SetupOptions & { help?: boolean } {
  const s = { type: "string" } as const;
  const { values: { "wallet-password-env": walletPasswordEnv, ...values } } = parseArgs({
    args: argv,
    strict: true,
    allowNegative: true,
    options: {
      env: s, provider: s, set: { type: "string", multiple: true }, model: s, agent: s, role: s,
      name: s, business: s, description: s, goals: s, budget: s, "wallet-password-env": s,
      init: { type: "boolean" }, "taskfast-skill": { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  const { "taskfast-skill": taskfastSkill, ...rest } = values;
  return { ...rest, ...(walletPasswordEnv === undefined ? {} : { walletPasswordEnv }), ...(taskfastSkill === undefined ? {} : { taskfastSkill }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let opts: ReturnType<typeof parseSetupArgs>;
  try {
    opts = parseSetupArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  // Interactive prompts release the terminal after each answer. Only pipes keep
  // a readline open, so taskfast init never inherits a prompt's raw mode.
  const rl = process.stdin.isTTY ? undefined : createInterface({ input: process.stdin, terminal: false });
  // The line iterator buffers lines until they are asked for; rl.question() drops lines
  // that arrive while no question is open, which loses piped answers.
  const lines = rl?.[Symbol.asyncIterator]();
  const io: SetupIO = {
    root: process.cwd(),
    env: process.env,
    log: (line) => console.log(line),
    ask: async (question, hidden = false) => {
      if (!lines) {
        const message = question.trim();
        return hidden ? password({ message, mask: "*", toggleMask: false }) : (await input({ message })).trim();
      }
      process.stdout.write(question);
      const next = await lines.next();
      if (next.done) throw new Error("input ended before setup finished; pass the remaining answers as flags (see --help)");
      return hidden ? next.value : next.value.trim();
    },
    run: (cmd, args, cwd, env) => {
      rl?.pause();
      process.stdin.pause();
      try {
        const r = spawnSync(cmd, args, { cwd, env, stdio: "inherit" });
        if (r.error) console.error(`${cmd}: ${r.error.message}`);
        return r.status ?? 1;
      } finally {
        rl?.resume();
      }
    },
    capture: (cmd, args, cwd, env) => {
      const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
      if (r.error) console.error(`${cmd}: ${r.error.message}`);
      return { status: r.status ?? 1, stdout: r.stdout ?? "" };
    },
  };
  try {
    await setup(io, opts);
  } catch (e) {
    const cancelled = e instanceof Error && e.name === "ExitPromptError";
    console.error(cancelled ? "\nSetup cancelled." : `\nSetup stopped: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = cancelled ? 130 : 1;
  } finally {
    rl?.close();
  }
}
