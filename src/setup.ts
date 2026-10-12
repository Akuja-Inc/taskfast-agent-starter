import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import input from "@inquirer/input";
import password from "@inquirer/password";
import { providerSource } from "./core/model.js";
import { parseAgentSpec } from "./core/spec.js";
import type { AgentSpec, Role } from "./core/types.js";
import { ENVIRONMENTS, taskfastEnv, type Environment } from "./run.js";

// One entry of providers.json, which scripts/gen-providers.mjs in the TaskFast repo
// generates from the AI SDK's provider packages and models.dev.
export interface Provider {
  id: string;
  package: string;
  export?: string;
  // The version the catalogue was built from; setup installs exactly this one.
  version?: string;
  label: string;
  settings: { name: string; required: boolean; description: string }[];
  // Tool-calling text models, newest first.
  models: string[];
  // The suggestion (gen-providers.mjs modelMenu): the provider's newest own model, else
  // the newest model models.dev traces to a maker (OpenRouter suggests another maker's
  // model), else its newest usable model; empty when models.dev lists none (Ollama).
  defaultModel: string;
  note?: string;
}

export const readCatalogue = (root: string): Provider[] => (JSON.parse(readFileSync(join(root, "providers.json"), "utf8")) as { providers: Provider[] }).providers;

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
  init?: boolean;
}

export const USAGE = `Usage: pnpm setup-agent [options]

Sets up a model provider and one agent. Anything you leave out is asked.

  --env production|staging|development
                          Where the agent's TaskFast account lives (default: production).
                          development is a TaskFast server on this machine (127.0.0.1:4000).
  --provider <id>         Model provider, e.g. anthropic, openai, moonshotai, openrouter,
                          ollama, or any @ai-sdk/<id> package (see providers.json)
  --set NAME=value        A provider setting for .env, e.g. --set ANTHROPIC_API_KEY=sk-...
                          Repeat for each setting. --set NAME takes the value from your
                          environment, which keeps it out of your shell history.
  --model <id>            Model id, e.g. claude-haiku-5-5
  --agent <folder>        Agent folder under agents/ (lowercase letters, digits, dashes)
  --role worker|poster|both
  --name <text>           Your name, as the agent signs it
  --business <text>       Business name
  --description <text>    What the business does, in one sentence
  --goals <text>          What the agent should aim for
  --budget <usd>          Budget per job, for a poster or both-sides agent
  --init / --no-init      Run taskfast init for the agent now, or skip it
  -h, --help              Show this help`;

// The example each role starts from; the user's answers replace its character.
const EXAMPLE: Record<Role, string> = { worker: "careful-worker.json", poster: "brisk-poster.json", both: "both-sides.json" };
const ROLES: Record<Role, string> = { worker: "Take jobs (worker)", poster: "Post jobs (poster)", both: "Both" };

// How many models the menu lists; any other id can be typed.
const SHOWN = 15;

export interface SetupIO {
  root: string;
  env: NodeJS.ProcessEnv;
  ask(question: string, hidden?: boolean): Promise<string>;
  // Runs a command with the terminal attached; returns its exit status.
  run(cmd: string, args: string[], cwd: string): number;
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

// The version of pkg the project resolves, or null when it is not installed. Read from
// the package.json above its entry file, since not every package exports
// "./package.json".
export function installedVersion(root: string, pkg: string): string | null {
  let dir: string;
  try {
    dir = dirname(createRequire(join(root, "package.json")).resolve(pkg));
  } catch {
    return null;
  }
  for (; dir !== dirname(dir); dir = dirname(dir)) {
    const file = join(dir, "package.json");
    if (!existsSync(file)) continue;
    const p = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
    if (p.name === pkg) return p.version ?? null;
  }
  return null;
}

// A setting whose value is a credential is masked while typing.
const secret = (name: string) => /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/.test(name);

const agentProblem = (root: string, v: string) =>
  !FOLDER.test(v) ? "use lowercase letters, digits and dashes" : existsSync(join(root, "agents", v, "agent.json")) ? `agents/${v} already has an agent.json; pick another name` : null;

// Checks every flag before setup changes anything, so a typo cannot leave a half-done
// setup. Returns the --set values by name.
function checkOptions(o: SetupOptions, io: SetupIO): Map<string, string> {
  const problems: string[] = [];
  const bad = (flag: string, why: string) => problems.push(`--${flag}: ${why}`);
  if (o.env !== undefined && !Object.hasOwn(ENVIRONMENTS, o.env)) bad("env", `use production, staging or development, not ${JSON.stringify(o.env)}`);
  if (o.provider !== undefined && !/^[a-z0-9-]+$/.test(o.provider)) bad("provider", "use the provider id, lowercase letters, digits and dashes");
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
    if (!(Number(o.budget) > 0)) bad("budget", "enter a positive number of USD");
    else if (o.role === "worker") bad("budget", "a worker has no budget; it applies to poster and both");
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
    const v = (await io.ask(fallback ? `${question} [${fallback}]: ` : `${question}: `, hidden)) || fallback;
    const problem = v ? check(v) : "an answer is needed";
    if (!problem) return v;
    io.log(problem);
  }
}

// The model: one of the provider's newest models by number, or any id typed out.
async function pickModel(io: SetupIO, p: Provider): Promise<string> {
  const shown = p.models.slice(0, SHOWN);
  if (shown.length) {
    io.log(`\nModels on ${p.label}, newest first:`);
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

// Sets up the model provider, its settings and one agent: installs the provider
// package, writes .env and agents/<id>/agent.json, then runs taskfast init. Values
// passed in `o` are used as given; the rest are asked.
export async function setup(io: SetupIO, o: SetupOptions = {}): Promise<void> {
  const set = checkOptions(o, io);
  const environment = (o.env ?? "production") as Environment;
  io.log("TaskFast agent setup. Press Enter to take the value in [brackets].");
  io.log(`Environment: ${environment}${o.env ? "" : " (pass --env staging or --env development to change it)"}\n`);

  // 1. Model provider and its package.
  const catalogue = readCatalogue(io.root);
  const other: Provider = { id: "", package: "", label: "Another @ai-sdk provider (enter its name)", settings: [], models: [], defaultModel: "" };
  const picked = o.provider ? (catalogue.find((p) => p.id === o.provider) ?? { ...other, id: o.provider }) : await choose(io, "Which model provider will your agent use?", [...catalogue, other], (p) => p.label, 0, (p) => p.id);
  let provider: Provider = picked;
  if (!catalogue.includes(picked)) {
    // Not in providers.json: an @ai-sdk/<id> package whose settings the user names.
    const id = picked.id || (await text(io, "Provider package name, as in @ai-sdk/<name>", "", (v) => (/^[a-z0-9-]+$/.test(v) ? null : "use lowercase letters, digits and dashes")));
    const keys = set.size ? [...set.keys()] : [await text(io, "Its API key variable (see its page on ai-sdk.dev)", "", (v) => (SETTING.test(v) ? null : "use the variable name, e.g. MY_PROVIDER_API_KEY"))];
    provider = { ...other, id, package: providerSource(id).package, label: `@ai-sdk/${id}`, settings: keys.map((name) => ({ name, required: true, description: "" })) };
  }
  if (provider.note) io.log(`\nNote: ${provider.note}`);
  // The catalogue's settings and models were read from provider.version, so that is the
  // version installed: added when missing, replaced when another is installed (F7).
  const found = installedVersion(io.root, provider.package);
  if (found === null || (provider.version && found !== provider.version)) {
    const spec = provider.version ? `${provider.package}@${provider.version}` : provider.package;
    io.log(found === null ? `\nInstalling ${spec} ...` : `\n${provider.package}@${found} is installed; setup was built for ${provider.version}. Installing ${spec} ...`);
    if (io.run("pnpm", ["add", spec], io.root) !== 0) throw new Error(`pnpm add ${spec} failed`);
  }

  // 2. The provider's settings, kept in .env (git-ignored); `pnpm dev` passes them on.
  // A --set value is written as given; a required setting already in .env is kept;
  // any other required setting is asked.
  const envPath = join(io.root, ".env");
  let envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const save = (name: string, value: string) => {
    envText = upsertEnv(envText, name, value);
    writeFileSync(envPath, envText, { mode: 0o600 });
    chmodSync(envPath, 0o600);
    io.log(`Saved ${name} to .env`);
  };
  for (const [name, value] of set) save(name, value);
  for (const s of provider.settings.filter((s) => s.required && !set.has(s.name))) {
    if (envText.split("\n").some((l) => l.startsWith(`${s.name}=`) && l.length > s.name.length + 1)) {
      io.log(`Using ${s.name} already in .env (pass --set ${s.name}=... to replace it)`);
      continue;
    }
    const what = s.description ? ` (${s.description})` : "";
    save(s.name, await text(io, `\n${secret(s.name) ? "Paste" : "Enter"} your ${s.name}${what}${secret(s.name) ? ", input is masked; press Enter to continue" : ""}`, "", (v) => (VALUE.test(v) ? null : "that value has spaces, quotes, backslashes or #"), secret(s.name)));
  }
  const optional = provider.settings.filter((s) => !s.required && !set.has(s.name)).map((s) => s.name);
  if (optional.length) io.log(`\nOptional settings, if you need them, go in .env too (or pass --set): ${optional.join(", ")}`);
  if (provider.id === "anthropic" && io.env.ANTHROPIC_BASE_URL && !io.env.ANTHROPIC_BASE_URL.replace(/\/$/, "").endsWith("/v1")) {
    io.log(`Warning: your shell sets ANTHROPIC_BASE_URL=${io.env.ANTHROPIC_BASE_URL}. Unset it before \`pnpm dev\`, or the agent's model calls fail with "Not Found".`);
  }
  const model = `${provider.id}:${o.model ?? (await pickModel(io, provider))}`;

  // 3. The agent.
  const id = o.agent ?? (await text(io, "\nAgent folder name (agents/<name>)", "my-agent", (v) => agentProblem(io.root, v)));
  const role = (o.role as Role | undefined) ?? (await choose(io, "\nWhat will it do on TaskFast?", Object.keys(ROLES) as Role[], (r) => ROLES[r]));
  if (o.budget !== undefined && role === "worker") throw new Error("--budget: a worker has no budget; it applies to poster and both");
  const example = JSON.parse(readFileSync(join(io.root, "examples", EXAMPLE[role]), "utf8")) as AgentSpec;
  const character: AgentSpec["character"] = {
    name: o.name ?? (await text(io, "Your name, as the agent signs it")),
    businessName: o.business ?? (await text(io, "Business name")),
    businessDescription: o.description ?? (await text(io, "What the business does, in one sentence")),
    goals: o.goals ?? (await text(io, "What the agent should aim for", example.character.goals)),
  };
  if (role !== "worker") {
    character.budgetUsd = Number(o.budget ?? (await text(io, "Budget per job in USD", String(example.character.budgetUsd ?? 20), (v) => (Number(v) > 0 ? null : "enter a positive number"))));
  }
  const spec = parseAgentSpec({ ...example, role, model, character });
  const dir = join(io.root, "agents", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.json"), `${JSON.stringify(spec, null, 2)}\n`);
  io.log(`\nWrote agents/${id}/agent.json (dials, temperament and limits come from examples/${EXAMPLE[role]}; edit them there any time).`);

  // 4. The agent's TaskFast account, in the environment given by --env.
  const cliEnv = taskfastEnv(environment);
  const initArgs = [...(cliEnv === "prod" ? [] : ["--env", cliEnv]), "init"];
  const initCmd = `taskfast ${initArgs.join(" ")}`;
  const ran = o.init ?? !/^n/i.test(await io.ask(`\nRun \`${initCmd}\` in agents/${id} now? It signs the agent up on ${environment} and sets up its wallet. [Y/n]: `));
  const status = ran ? io.run("taskfast", initArgs, dir) : -1;
  if (status !== 0) io.log(`\n${ran ? "taskfast init did not finish. " : ""}Run it yourself when ready:\n  cd agents/${id} && ${initCmd}`);

  io.log(`\nNext, in two terminals:\n  pnpm dev\n  pnpm agents${environment === "production" ? "" : ` --env ${environment}`}`);
}

// Reads setup's command-line flags; throws on an unknown flag.
export function parseSetupArgs(argv: string[]): SetupOptions & { help?: boolean } {
  const s = { type: "string" } as const;
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowNegative: true,
    options: {
      env: s, provider: s, set: { type: "string", multiple: true }, model: s, agent: s, role: s,
      name: s, business: s, description: s, goals: s, budget: s,
      init: { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  return values;
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
        return (await (hidden ? password({ message, mask: "*", toggleMask: false }) : input({ message }))).trim();
      }
      process.stdout.write(question);
      const next = await lines.next();
      if (next.done) throw new Error("input ended before setup finished; pass the remaining answers as flags (see --help)");
      return next.value.trim();
    },
    run: (cmd, args, cwd) => {
      rl?.pause();
      process.stdin.pause();
      try {
        const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
        if (r.error) console.error(`${cmd}: ${r.error.message}`);
        return r.status ?? 1;
      } finally {
        rl?.resume();
      }
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
