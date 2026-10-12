import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { providerSource } from "../src/core/model.js";
import { splitModel } from "../src/core/spec.js";
import { taskfastEnv } from "../src/run.js";
import { installedVersion, parseSetupArgs, readCatalogue, setup, upsertEnv, type SetupIO, type SetupOptions } from "../src/setup.js";

const ROOT = join(import.meta.dirname, "..");
const CATALOGUE = readCatalogue(ROOT);
const entry = (id: string) => CATALOGUE.find((p) => p.id === id)!;

// A kit folder with the real examples, providers.json and node_modules (so anthropic
// and openai are installed), answered from a script. run() records commands and
// returns runStatus.
function kit(answers: string[], opts: { env?: NodeJS.ProcessEnv; envFile?: string; runStatus?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kit-"));
  writeFileSync(join(root, "package.json"), "{}");
  cpSync(join(ROOT, "examples"), join(root, "examples"), { recursive: true });
  cpSync(join(ROOT, "providers.json"), join(root, "providers.json"));
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  if (opts.envFile !== undefined) writeFileSync(join(root, ".env"), opts.envFile);
  const asked: { question: string; hidden: boolean }[] = [];
  const ran: { cmd: string; args: string[]; cwd: string }[] = [];
  const logs: string[] = [];
  const io: SetupIO = {
    root,
    env: opts.env ?? {},
    ask: async (question, hidden = false) => {
      asked.push({ question, hidden });
      if (!answers.length) throw new Error(`no scripted answer for: ${question}`);
      return answers.shift()!;
    },
    run: (cmd, args, cwd) => (ran.push({ cmd, args, cwd }), opts.runStatus ?? 0),
    log: (line) => void logs.push(line),
  };
  const agent = (id: string) => JSON.parse(readFileSync(join(root, "agents", id, "agent.json"), "utf8"));
  const run = (o: SetupOptions = {}) => setup(io, o);
  return { root, io, asked, ran, logs, agent, run, env: () => readFileSync(join(root, ".env"), "utf8") };
}

const ME = ["Ada Lovelace", "Ada Analytics", "Data clean-up for small charities."];
// After the model: folder, role worker, the character (goals default), then run init?
const worker = (folder: string, init = "n") => [folder, "1", ...ME, "", init];
// Every answer as a flag.
const ALL: SetupOptions = {
  provider: "anthropic", set: ["ANTHROPIC_API_KEY=sk-ant-flag"], model: "claude-sonnet-5-5", agent: "flagged", role: "poster",
  name: ME[0], business: ME[1], description: ME[2], goals: "hire well", budget: "40", init: true,
};

describe("setup", () => {
  it("sets up an installed provider: hidden key into .env, the suggested model, the agent file, then taskfast init on production by default", async () => {
    const k = kit(["1", "sk-ant-test123", "", ...worker("ada", "")]);
    await k.run();
    expect(k.env()).toBe("ANTHROPIC_API_KEY=sk-ant-test123\n");
    expect(statSync(join(k.root, ".env")).mode & 0o777).toBe(0o600);
    expect(k.asked.filter((a) => a.hidden).map((a) => a.question)).toEqual([expect.stringContaining("ANTHROPIC_API_KEY")]);
    const a = k.agent("ada");
    expect(a.model).toBe(`anthropic:${entry("anthropic").defaultModel}`);
    expect(a.role).toBe("worker");
    expect(a.character).toEqual({ name: ME[0], businessName: ME[1], businessDescription: ME[2], goals: expect.any(String) });
    expect(k.ran).toEqual([{ cmd: "taskfast", args: ["init"], cwd: join(k.root, "agents", "ada") }]);
    expect(k.logs).toContain("Environment: production (pass --env staging or --env development to change it)\n");
    expect(k.logs.join("\n")).toMatch(/pnpm agents$/);
  });

  it("never asks where the agent runs: --env picks it", async () => {
    for (const [env, args, next] of [
      ["staging", ["--env", "staging", "init"], "pnpm agents --env staging"],
      ["development", ["--env", "local", "init"], "pnpm agents --env development"],
      ["production", ["init"], "pnpm agents"],
    ] as const) {
      const k = kit(["anthropic", "sk-x", "", ...worker("w", "")]);
      await k.run({ env });
      // provider, key, model, folder, role, name, business, description, goals, run init:
      // no production/staging menu (the old "Choose 1-2") among them.
      expect(k.asked).toHaveLength(10);
      expect(k.asked.filter((a) => a.question.startsWith("Choose 1-2 "))).toEqual([]);
      expect(k.logs.join("\n")).not.toContain("Where will it run?");
      expect(k.ran.at(-1)!.args).toEqual(args);
      expect(k.logs.join("\n")).toContain(next);
    }
  });

  it("asks nothing when every answer is passed as a flag", async () => {
    const k = kit([]);
    await k.run({ ...ALL, env: "staging" });
    expect(k.asked).toEqual([]);
    expect(k.env()).toBe("ANTHROPIC_API_KEY=sk-ant-flag\n");
    expect(k.agent("flagged")).toMatchObject({ role: "poster", model: "anthropic:claude-sonnet-5-5", character: { name: ME[0], businessName: ME[1], businessDescription: ME[2], goals: "hire well", budgetUsd: 40 } });
    expect(k.ran).toEqual([{ cmd: "taskfast", args: ["--env", "staging", "init"], cwd: join(k.root, "agents", "flagged") }]);
  });

  it("takes a --set NAME value from the environment, and asks only what was not passed", async () => {
    const k = kit(["Data clean-up for small charities.", ""], { env: { MOONSHOT_API_KEY: "mk-from-env" } });
    await k.run({ provider: "moonshotai", set: ["MOONSHOT_API_KEY"], model: "kimi-k3", agent: "half", role: "worker", name: ME[0], business: ME[1], init: false });
    expect(k.env()).toBe("MOONSHOT_API_KEY=mk-from-env\n");
    expect(k.asked.map((a) => a.question)).toEqual([expect.stringContaining("What the business does"), expect.stringContaining("What the agent should aim for")]);
    expect(k.ran).toEqual([{ cmd: "pnpm", args: ["add", `@ai-sdk/moonshotai@${entry("moonshotai").version}`], cwd: k.root }]);
    expect(k.logs.join("\n")).toContain("cd agents/half && taskfast init");
  });

  it("checks every flag before changing anything, and names each problem", async () => {
    const k = kit([]);
    const run = k.run({ env: "prod", provider: "Bad Name", set: ["lower=x", "NOPE", "EMPTY="], model: "a b", agent: "Has Space", role: "admin", name: " ", budget: "-3" });
    await expect(run).rejects.toThrow(/--env: use production, staging or development, not "prod"/);
    await expect(run).rejects.toThrow(/--provider:/);
    await expect(run).rejects.toThrow(/--set: "lower" is not a setting name/);
    await expect(run).rejects.toThrow(/--set: NOPE is not set in your environment/);
    await expect(run).rejects.toThrow(/--set: EMPTY has no value/);
    await expect(run).rejects.toThrow(/--model: a model id has no spaces/);
    await expect(run).rejects.toThrow(/--agent: use lowercase letters/);
    await expect(run).rejects.toThrow(/--role: use worker, poster or both/);
    await expect(run).rejects.toThrow(/--name: it is empty/);
    await expect(run).rejects.toThrow(/--budget: enter a positive number/);
    expect(k.ran).toEqual([]);
    expect(existsSync(join(k.root, ".env"))).toBe(false);
    expect(k.asked).toEqual([]);
  });

  it("refuses a budget for a worker, whether the role was passed or chosen", async () => {
    await expect(kit([]).run({ role: "worker", budget: "10" })).rejects.toThrow("--budget: a worker has no budget");
    const k = kit(["anthropic", "sk-x", "", "w2", "1"]);
    await expect(k.run({ budget: "10" })).rejects.toThrow("--budget: a worker has no budget");
    expect(existsSync(join(k.root, "agents", "w2"))).toBe(false);
  });

  it("installs the catalogued version of a provider that is not installed, takes a model by number, and asks a poster for its budget", async () => {
    const k = kit(["moonshotai", "mk-test", "2", "shop", "2", ...ME, "", "35", ""]);
    await k.run({ env: "staging" });
    expect(k.ran[0]).toEqual({ cmd: "pnpm", args: ["add", `@ai-sdk/moonshotai@${entry("moonshotai").version}`], cwd: k.root });
    expect(k.env()).toBe("MOONSHOT_API_KEY=mk-test\n");
    expect(k.agent("shop")).toMatchObject({ role: "poster", model: `moonshotai:${entry("moonshotai").models[1]}`, character: { budgetUsd: 35 } });
    expect(k.ran[1]).toEqual({ cmd: "taskfast", args: ["--env", "staging", "init"], cwd: join(k.root, "agents", "shop") });
  });

  it("asks for every required setting, hiding only the secret ones, and lists the optional ones", async () => {
    const k = kit(["amazon-bedrock", "AKIAEXAMPLE", "us-east-1", "s3cr3t", "", ...worker("bed")]);
    await k.run();
    expect(k.env()).toBe("AWS_ACCESS_KEY_ID=AKIAEXAMPLE\nAWS_REGION=us-east-1\nAWS_SECRET_ACCESS_KEY=s3cr3t\n");
    const prompts = k.asked.filter((a) => a.question.includes("AWS_"));
    expect(prompts.map((a) => [a.question.match(/AWS_[A-Z_]+/)![0], a.hidden])).toEqual([["AWS_ACCESS_KEY_ID", true], ["AWS_REGION", false], ["AWS_SECRET_ACCESS_KEY", true]]);
    expect(k.logs.join("\n")).toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(k.logs.join("\n")).toContain(entry("amazon-bedrock").note);
    expect(k.agent("bed").model).toBe(`amazon-bedrock:${entry("amazon-bedrock").defaultModel}`);
  });

  it("needs a typed model for a provider with no suggestion, and asks no key for Ollama", async () => {
    const k = kit(["ollama", "", "qwen3:8b", ...worker("local")]);
    await k.run({ env: "development" });
    expect(k.logs).toContain("A model id is needed.");
    expect(existsSync(join(k.root, ".env"))).toBe(false);
    expect(k.agent("local").model).toBe("ollama:qwen3:8b");
  });

  it("keeps a setting already in .env without asking, and leaves the other lines alone", async () => {
    const k = kit(["openai", "", "a1", "3", ...ME, "", "", "n"], { envFile: "OTHER=1\nOPENAI_API_KEY=sk-old\n" });
    await k.run({ env: "staging" });
    expect(k.env()).toBe("OTHER=1\nOPENAI_API_KEY=sk-old\n");
    expect(k.asked.some((a) => a.question.includes("OPENAI_API_KEY"))).toBe(false);
    expect(k.logs).toContain("Using OPENAI_API_KEY already in .env (pass --set OPENAI_API_KEY=... to replace it)");
    expect(k.agent("a1").role).toBe("both");
    expect(k.ran).toEqual([]);
    expect(k.logs.join("\n")).toContain("cd agents/a1 && taskfast --env staging init");
  });

  it("replaces a setting in .env with --set", async () => {
    const k = kit([], { envFile: "OPENAI_API_KEY=sk-old\n" });
    await k.run({ ...ALL, provider: "openai", set: ["OPENAI_API_KEY=sk-new"], model: "gpt-6.1-sol", init: false });
    expect(k.env()).toBe("OPENAI_API_KEY=sk-new\n");
  });

  it("takes any other @ai-sdk provider by name, interactively or from flags", async () => {
    const k = kit([String(CATALOGUE.length + 1), "acme", "ACME_API_KEY", "ac-key", "acme-1", ...worker("c1")]);
    await k.run();
    expect(k.ran[0]!.args).toEqual(["add", "@ai-sdk/acme"]);
    expect(k.env()).toBe("ACME_API_KEY=ac-key\n");
    expect(k.agent("c1").model).toBe("acme:acme-1");

    const f = kit([]);
    await f.run({ ...ALL, provider: "acme", set: ["ACME_API_KEY=ac-2"], model: "acme-2", init: false });
    expect(f.ran[0]!.args).toEqual(["add", "@ai-sdk/acme"]);
    expect(f.env()).toBe("ACME_API_KEY=ac-2\n");
    expect(f.agent("flagged").model).toBe("acme:acme-2");
  });

  it("asks again after a wrong choice, a taken folder or a bad key, and says how to finish a failed init", async () => {
    const k = kit(["0", "nosuch", "anthropic", "has space", "sk-ok", "", "taken", "fresh", "1", ...ME, "", ""], { runStatus: 1 });
    mkdirSync(join(k.root, "agents", "taken"), { recursive: true });
    writeFileSync(join(k.root, "agents", "taken", "agent.json"), "{}");
    await k.run();
    expect(k.logs.filter((l) => l === `Enter a number from 1 to ${CATALOGUE.length + 1}.`)).toHaveLength(2);
    expect(k.logs).toContain("that value has spaces, quotes, backslashes or #");
    expect(k.logs).toContain("agents/taken already has an agent.json; pick another name");
    expect(existsSync(join(k.root, "agents", "fresh", "agent.json"))).toBe(true);
    expect(k.logs.join("\n")).toContain("taskfast init did not finish.");
  });

  // F7: an installed version other than the catalogued one is replaced, since the
  // settings setup asks for were read from the catalogued version.
  it("installs the catalogued version over a different installed one, and leaves a matching one alone", async () => {
    const k = kit([]);
    const pkgDir = join(k.root, "node_modules-own", "@ai-sdk", "anthropic");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@ai-sdk/anthropic", version: "4.0.1", main: "index.js" }));
    writeFileSync(join(pkgDir, "index.js"), "");
    const own = mkdtempSync(join(tmpdir(), "kit-own-"));
    cpSync(join(k.root, "examples"), join(own, "examples"), { recursive: true });
    cpSync(join(k.root, "providers.json"), join(own, "providers.json"));
    writeFileSync(join(own, "package.json"), "{}");
    mkdirSync(join(own, "node_modules", "@ai-sdk"), { recursive: true });
    symlinkSync(pkgDir, join(own, "node_modules", "@ai-sdk", "anthropic"));
    const io = { ...k.io, root: own };
    await setup(io, { ...ALL, init: false });
    expect(k.ran[0]).toEqual({ cmd: "pnpm", args: ["add", `@ai-sdk/anthropic@${entry("anthropic").version}`], cwd: own });
    expect(k.logs.join("\n")).toContain(`@ai-sdk/anthropic@4.0.1 is installed; setup was built for ${entry("anthropic").version}`);

    const same = kit([]);
    await same.run({ ...ALL, init: false });
    expect(same.ran).toEqual([]);
  });

  it("stops when the provider package fails to install", async () => {
    const k = kit(["groq"], { runStatus: 1 });
    await expect(k.run()).rejects.toThrow(`pnpm add @ai-sdk/groq@${entry("groq").version} failed`);
  });

  it("warns when the shell's ANTHROPIC_BASE_URL would break model calls", async () => {
    const k = kit(["anthropic", "sk-x", "", ...worker("w")], { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" } });
    await k.run();
    expect(k.logs.join("\n")).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:8787");
  });
});

describe("command line", () => {
  it("reads every flag, repeated --set and --no-init", () => {
    expect(parseSetupArgs(["--env", "staging", "--provider", "openai", "--set", "A=1", "--set", "B", "--model", "m", "--agent", "x", "--role", "both", "--name", "n", "--business", "b", "--description", "d", "--goals", "g", "--budget", "5", "--no-init"])).toEqual({
      env: "staging", provider: "openai", set: ["A=1", "B"], model: "m", agent: "x", role: "both", name: "n", business: "b", description: "d", goals: "g", budget: "5", init: false,
    });
    expect(parseSetupArgs(["--init"]).init).toBe(true);
  });

  it("refuses an unknown flag", () => {
    expect(() => parseSetupArgs(["--envv", "staging"])).toThrow(/Unknown option '--envv'/);
  });

  it("maps the kit's environment names to the taskfast CLI's", () => {
    expect(["production", "staging", "development"].map(taskfastEnv)).toEqual(["prod", "staging", "local"]);
    for (const other of ["dev", "prod", "local"]) expect(() => taskfastEnv(other)).toThrow("--env must be production, staging or development");
  });
});

describe("upsertEnv", () => {
  it("replaces a key's line or appends one", () => {
    expect(upsertEnv("A=1\nB=2\n", "A", "9")).toBe("A=9\nB=2\n");
    expect(upsertEnv("A=1", "B", "2")).toBe("A=1\nB=2\n");
    expect(upsertEnv("", "B", "2")).toBe("B=2\n");
  });

  it.each(["a b", "a#b", 'a"b', ""])("refuses the value %j", (v) => {
    expect(() => upsertEnv("", "K", v)).toThrow(/must not contain/);
  });
});

// providers.json is generated (scripts/gen-providers.mjs); these hold for any run of it.
describe("providers.json", () => {
  it("offers every provider once, the main ones first, OpenRouter and Ollama included", () => {
    const ids = CATALOGUE.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 4)).toEqual(["anthropic", "openai", "google", "moonshotai"]);
    expect(ids).toEqual(expect.arrayContaining(["openrouter", "ollama", "gateway", "amazon-bedrock", "google-vertex", "mistral", "xai", "deepseek"]));
  });

  // F7: the catalogue's settings and models were read at p.version, so a provider the
  // kit installs itself must be pinned to exactly that version.
  it("pins each provider the kit installs to the version the catalogue describes", () => {
    const pins = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies;
    const shipped = CATALOGUE.filter((p) => pins[p.package]);
    expect(shipped.map((p) => p.id).sort()).toEqual(["anthropic", "openai"]);
    for (const p of shipped) expect(`${p.package}@${pins[p.package]}`).toBe(`${p.package}@${p.version}`);
    for (const p of shipped) expect(installedVersion(ROOT, p.package)).toBe(p.version);
  });

  it.each(CATALOGUE)("$id: the package core/model.ts loads, an exact version, a valid suggested model and named settings", (p) => {
    expect(providerSource(p.id)).toEqual({ package: p.package, export: p.export });
    expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
    if (p.defaultModel) {
      expect(p.models).toContain(p.defaultModel);
      expect(splitModel(`${p.id}:${p.defaultModel}`).provider).toBe(p.id);
    } else expect(p.id).toBe("ollama");
    for (const s of p.settings) expect(s.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(p.settings.some((s) => s.required)).toBe(p.id !== "ollama");
  });
});
