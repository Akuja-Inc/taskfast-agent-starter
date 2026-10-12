import { execFileSync, spawnSync } from "node:child_process";
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
const entry = (id: string) => {
  const p = CATALOGUE.find((p) => p.id === id);
  if (!p) throw new Error(`missing provider ${id}`);
  return p;
};

function kit(answers: string[], opts: { env?: NodeJS.ProcessEnv; envFile?: string; runStatus?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kit-"));
  writeFileSync(join(root, "package.json"), readFileSync(join(ROOT, "package.json")));
  cpSync(join(ROOT, "examples"), join(root, "examples"), { recursive: true });
  cpSync(join(ROOT, "providers.json"), join(root, "providers.json"));
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  if (opts.envFile !== undefined) writeFileSync(join(root, ".env"), opts.envFile);
  const asked: { question: string; hidden: boolean }[] = [];
  const ran: { cmd: string; args: string[]; cwd: string }[] = [];
  const logs: string[] = [];
  const io: SetupIO = {
    root, env: opts.env ?? {},
    ask: async (question, hidden = false) => {
      asked.push({ question, hidden });
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`no scripted answer for: ${question}`);
      return answer;
    },
    run: (cmd, args, cwd) => (ran.push({ cmd, args, cwd }), opts.runStatus ?? 0),
    log: (line) => void logs.push(line),
  };
  const agent = (id: string) => JSON.parse(readFileSync(join(root, "agents", id, "agent.json"), "utf8"));
  return { root, io, asked, ran, logs, agent, run: (o: SetupOptions = {}) => setup(io, o), env: () => readFileSync(join(root, ".env"), "utf8") };
}
const ME = ["Ada Lovelace", "Ada Analytics", "Data clean-up for small charities."];
const worker = (folder: string, init = "n") => [folder, "1", ...ME, "", init];
const ALL: SetupOptions = {
  provider: "anthropic", set: ["ANTHROPIC_API_KEY=sk-ant-flag"], model: "claude-sonnet-5-5", agent: "flagged", role: "poster",
  name: ME[0], business: ME[1], description: ME[2], goals: "hire well", budget: "40", init: true,
};

describe("setup", () => {
  it("asks for a hidden native key, saves privately, selects a catalog model and initializes production by default without installing", async () => {
    const k = kit(["1", "sk-ant-test123", "", ...worker("ada", "")]);
    await k.run();
    expect(k.env()).toBe("ANTHROPIC_API_KEY=sk-ant-test123\n");
    expect(statSync(join(k.root, ".env")).mode & 0o777).toBe(0o600);
    expect(k.asked.filter((a) => a.hidden).map((a) => a.question)).toEqual([expect.stringContaining("ANTHROPIC_API_KEY")]);
    expect(k.agent("ada")).toMatchObject({ model: `anthropic:${entry("anthropic").defaultModel}`, role: "worker", character: { name: ME[0], businessName: ME[1], businessDescription: ME[2] } });
    expect(k.ran).toEqual([{ cmd: "taskfast", args: ["init"], cwd: join(k.root, "agents", "ada") }]);
    expect(k.logs).toContain("Environment: production (pass --env staging or --env development to change it)\n");
    expect(k.logs.join("\n")).not.toContain("sk-ant-test123");
  });

  it.each([
    ["staging", ["--env", "staging", "init"], "pnpm agents --env staging"],
    ["development", ["--env", "local", "init"], "pnpm agents --env development"],
    ["production", ["init"], "pnpm agents"],
  ])("uses --env %s without asking where the agent runs", async (env, args, next) => {
    const k = kit(["anthropic", "sk-x", "", ...worker("w", "")]);
    await k.run({ env });
    expect(k.asked).toHaveLength(10);
    expect(k.ran.at(-1)?.args).toEqual(args);
    expect(k.logs.join("\n")).toContain(next);
  });

  it("answers every question with flags, including --set NAME from the environment", async () => {
    const k = kit([], { env: { ANTHROPIC_API_KEY: "key-from-environment" } });
    await k.run({ ...ALL, set: ["ANTHROPIC_API_KEY"], env: "staging" });
    expect(k.asked).toEqual([]);
    expect(k.env()).toBe("ANTHROPIC_API_KEY=key-from-environment\n");
    expect(k.agent("flagged")).toMatchObject({ role: "poster", model: "anthropic:claude-sonnet-5-5", character: { budgetUsd: 40 } });
    expect(k.ran).toEqual([{ cmd: "taskfast", args: ["--env", "staging", "init"], cwd: join(k.root, "agents", "flagged") }]);
    expect(k.logs.join("\n")).not.toContain("key-from-environment");
  });

  it("asks only what flags leave out, with no provider install command", async () => {
    const k = kit([ME[2] ?? "description", ""], { env: { MOONSHOT_API_KEY: "mk-from-env" } });
    await k.run({ provider: "moonshotai", set: ["MOONSHOT_API_KEY"], model: "kimi-k3", agent: "half", role: "worker", name: ME[0], business: ME[1], init: false });
    expect(k.env()).toBe("MOONSHOT_API_KEY=mk-from-env\n");
    expect(k.asked.map((a) => a.question)).toEqual([expect.stringContaining("What the business does"), expect.stringContaining("What the agent should aim for")]);
    expect(k.ran).toEqual([]);
  });

  it("checks every flag before filesystem/command side effects and reports each problem", async () => {
    const k = kit([]);
    const run = k.run({ env: "prod", provider: "Bad Name", set: ["lower=x", "NOPE", "EMPTY="], model: "a b", agent: "Has Space", role: "admin", name: " ", budget: "-3" });
    for (const problem of [/--env:/, /--provider:/, /--set: "lower"/, /--set: NOPE/, /--set: EMPTY/, /--model:/, /--agent:/, /--role:/, /--name:/, /--budget:/]) await expect(run).rejects.toThrow(problem);
    expect(k.ran).toEqual([]);
    expect(k.asked).toEqual([]);
    expect(existsSync(join(k.root, ".env"))).toBe(false);
    expect(existsSync(join(k.root, "agents"))).toBe(false);
  });

  it.each(["acme", "alibaba", "anthropic-aws", "cohere", "deepinfra", "gmicloud", "openai-codex", "typesafe"])("rejects unsupported --provider %s before any side effects or secret prompts", async (provider) => {
    const k = kit([], { envFile: "KEEP=unchanged\n" });
    await expect(k.run({ ...ALL, provider })).rejects.toThrow(/unsupported provider/);
    expect(k.asked).toEqual([]);
    expect(k.ran).toEqual([]);
    expect(k.env()).toBe("KEEP=unchanged\n");
    expect(existsSync(join(k.root, "agents"))).toBe(false);
  });

  it.each([
    ["google", "GOOGLE_GENERATIVE_AI_API_KEY=old-key", "gemini-2.5-flash"],
    ["azure", "AZURE_API_KEY=old-key", "my-deployment"],
    ["openai", "OPENAI_BASE_URL=http://localhost:8000/v1", "gpt-5-mini"],
    ["anthropic", "ANTHROPIC_BASE_URL=http://localhost:8000/v1", "claude-sonnet-5-5"],
  ])("refuses stale/unsupported --set settings for %s before writes", async (provider, setting, model) => {
    const k = kit([]);
    await expect(k.run({ ...ALL, provider, set: [setting], model })).rejects.toThrow(/not a setting/);
    expect(k.asked).toEqual([]);
    expect(k.ran).toEqual([]);
    expect(existsSync(join(k.root, ".env"))).toBe(false);
  });

  it("validates a flagged native model before saving settings or hardening an existing file", async () => {
    const k = kit([], { envFile: "KEEP=unchanged\n" });
    const before = statSync(join(k.root, ".env")).mode;
    await expect(k.run({ ...ALL, model: "not-in-the-pin" })).rejects.toThrow(/unsupported model/);
    expect(k.env()).toBe("KEEP=unchanged\n");
    expect(statSync(join(k.root, ".env")).mode).toBe(before);
    expect(k.ran).toEqual([]);
    expect(existsSync(join(k.root, "agents"))).toBe(false);
  });

  it("refuses non-finite budgets before side effects and a budget for a worker", async () => {
    for (const budget of ["Infinity", "NaN", "-1"]) await expect(kit([]).run({ ...ALL, budget })).rejects.toThrow(/--budget:/);
    await expect(kit([]).run({ role: "worker", budget: "10" })).rejects.toThrow("--budget: a worker has no budget");
    const k = kit(["anthropic", "sk-x", "", "w2", "1"]);
    await expect(k.run({ budget: "10" })).rejects.toThrow("--budget: a worker has no budget");
    expect(existsSync(join(k.root, "agents", "w2"))).toBe(false);
  });

  it("selects a model by number and asks a poster budget, with only TaskFast as a child command", async () => {
    const k = kit(["moonshotai", "mk-test", "2", "shop", "2", ...ME, "", "35", ""]);
    await k.run({ env: "staging" });
    expect(k.agent("shop")).toMatchObject({ role: "poster", model: `moonshotai:${entry("moonshotai").models[1]}`, character: { budgetUsd: 35 } });
    expect(k.ran).toEqual([{ cmd: "taskfast", args: ["--env", "staging", "init"], cwd: join(k.root, "agents", "shop") }]);
  });

  it("Bedrock defaults to one bearer token instead of demanding AWS key pairs", async () => {
    const k = kit(["amazon-bedrock", "bedrock-test-token", "", ...worker("bed")]);
    await k.run();
    expect(k.env()).toBe("AWS_BEARER_TOKEN_BEDROCK=bedrock-test-token\n");
    const prompts = k.asked.filter((a) => a.question.includes("AWS_"));
    expect(prompts).toEqual([{ question: expect.stringContaining("AWS_BEARER_TOKEN_BEDROCK"), hidden: true }]);
    expect(k.logs.join("\n")).toContain("AWS_PROFILE");
    expect(k.ran).toEqual([]);
  });

  it.each([
    ["amazon-bedrock", ["AWS_PROFILE=existing", "AWS_REGION=us-west-2"], "AWS_PROFILE"],
    ["amazon-bedrock", ["AWS_ACCESS_KEY_ID=test-access", "AWS_SECRET_ACCESS_KEY=test-secret"], "AWS_SECRET_ACCESS_KEY"],
    ["google-vertex", ["GOOGLE_CLOUD_API_KEY=cloud-key"], "GOOGLE_CLOUD_API_KEY"],
    ["google-vertex", ["GOOGLE_CLOUD_PROJECT=my-project", "GOOGLE_CLOUD_LOCATION=us-central1"], "GOOGLE_CLOUD_PROJECT"],
    ["azure", ["AZURE_OPENAI_API_KEY=azure-key", "AZURE_OPENAI_RESOURCE_NAME=resource"], "AZURE_OPENAI_RESOURCE_NAME"],
    ["anthropic", ["ANTHROPIC_OAUTH_TOKEN=existing-token"], "ANTHROPIC_OAUTH_TOKEN"],
  ])("supports the explicit %s auth alternative without unrelated prompts (%s)", async (provider, set, saved) => {
    const k = kit([]);
    const values = [...set];
    if (provider === "google-vertex" && !set.some((s) => s.startsWith("GOOGLE_CLOUD_API_KEY="))) {
      const file = join(k.root, "service-account.json");
      writeFileSync(file, "{}");
      values.push(`GOOGLE_APPLICATION_CREDENTIALS=${file}`);
    }
    await k.run({ ...ALL, provider, set: values, model: entry(provider).defaultModel, init: false });
    expect(k.asked).toEqual([]);
    expect(k.env()).toContain(`${saved}=`);
    expect(k.ran).toEqual([]);
    for (const setting of set) expect(k.logs.join("\n")).not.toContain(setting.split("=")[1]);
  });

  it("refuses missing Vertex ADC files before writes, and a service-account path selects the ADC prompts", async () => {
    const missing = kit([], { env: { HOME: "/nonexistent-home" } });
    await expect(missing.run({ ...ALL, provider: "google-vertex", set: ["GOOGLE_CLOUD_PROJECT=project", "GOOGLE_CLOUD_LOCATION=region"], model: entry("google-vertex").defaultModel, init: false })).rejects.toThrow(/Vertex ADC needs/);
    expect(existsSync(join(missing.root, ".env"))).toBe(false);
    expect(missing.ran).toEqual([]);
    const partial = kit(["region", "project"]);
    const file = join(partial.root, "service-account.json");
    writeFileSync(file, "{}");
    await partial.run({ ...ALL, provider: "google-vertex", set: [`GOOGLE_APPLICATION_CREDENTIALS=${file}`], model: entry("google-vertex").defaultModel, init: false });
    expect(partial.asked.map((p) => p.question)).toEqual([expect.stringContaining("GOOGLE_CLOUD_LOCATION"), expect.stringContaining("GOOGLE_CLOUD_PROJECT")]);
    expect(partial.env()).not.toContain("GOOGLE_CLOUD_API_KEY=");
  });

  it("a partial AWS key pair asks for only the missing secret, with echo hidden", async () => {
    const k = kit(["missing-secret"]);
    await k.run({ ...ALL, provider: "amazon-bedrock", set: ["AWS_ACCESS_KEY_ID=access"], model: entry("amazon-bedrock").defaultModel, init: false });
    expect(k.asked).toEqual([{ question: expect.stringContaining("AWS_SECRET_ACCESS_KEY"), hidden: true }]);
    expect(k.env()).toBe("AWS_ACCESS_KEY_ID=access\nAWS_SECRET_ACCESS_KEY=missing-secret\n");
  });

  it("uses native Google key naming, and valid gateway/together aliases remain in the agent file", async () => {
    for (const [provider, variable] of [["google", "GEMINI_API_KEY"], ["gateway", "AI_GATEWAY_API_KEY"], ["togetherai", "TOGETHER_API_KEY"]]) {
      if (!provider || !variable) throw new Error("missing test case");
      const k = kit([]);
      await k.run({ ...ALL, provider, set: [`${variable}=test-key`], model: entry(provider).defaultModel, init: false });
      expect(k.agent("flagged").model).toBe(`${provider}:${entry(provider).defaultModel}`);
      expect(k.env()).toBe(`${variable}=test-key\n`);
      expect(k.ran).toEqual([]);
    }
  });

  it("needs a typed pulled model for Ollama, asks no key and writes no .env", async () => {
    const k = kit(["ollama", "", "qwen3:8b", ...worker("local")]);
    await k.run({ env: "development" });
    expect(k.logs).toContain("A model id is needed.");
    expect(existsSync(join(k.root, ".env"))).toBe(false);
    expect(k.agent("local").model).toBe("ollama:qwen3:8b");
    expect(k.ran).toEqual([]);
  });

  it("keeps existing keys and other .env lines but hardens an existing file to 0600", async () => {
    const k = kit(["openai", "", "a1", "3", ...ME, "", "", "n"], { envFile: "OTHER=1\nOPENAI_API_KEY=sk-old\n" });
    await k.run({ env: "staging" });
    expect(k.env()).toBe("OTHER=1\nOPENAI_API_KEY=sk-old\n");
    expect(statSync(join(k.root, ".env")).mode & 0o777).toBe(0o600);
    expect(k.asked.some((a) => a.question.includes("OPENAI_API_KEY"))).toBe(false);
    expect(k.logs.join("\n")).not.toContain("sk-old");
    expect(k.agent("a1").role).toBe("both");
    expect(k.ran).toEqual([]);
  });

  it("replaces an existing value with --set, and accepts shell-only keys without copying them", async () => {
    const k = kit([], { envFile: "OPENAI_API_KEY=sk-old\n" });
    await k.run({ ...ALL, provider: "openai", set: ["OPENAI_API_KEY=sk-new"], model: "gpt-5-mini", init: false });
    expect(k.env()).toBe("OPENAI_API_KEY=sk-new\n");
    const shell = kit([], { env: { OPENAI_API_KEY: "shell-only" } });
    await shell.run({ ...ALL, provider: "openai", set: [], model: "gpt-5-mini", init: false });
    expect(shell.asked).toEqual([]);
    expect(existsSync(join(shell.root, ".env"))).toBe(false);
    expect(shell.logs.join("\n")).not.toContain("shell-only");
  });

  it("reprompts wrong choices, stale models, taken folders and bad keys; describes failed init", async () => {
    const k = kit(["0", "nosuch", "anthropic", "has space", "sk-ok", "not-in-the-pin", "", "taken", "fresh", "1", ...ME, "", ""], { runStatus: 1 });
    mkdirSync(join(k.root, "agents", "taken"), { recursive: true });
    writeFileSync(join(k.root, "agents", "taken", "agent.json"), "{}");
    await k.run();
    expect(k.logs.filter((l) => l === `Enter a number from 1 to ${CATALOGUE.length}.`)).toHaveLength(2);
    expect(k.logs).toContain("that value has spaces, quotes, backslashes or #");
    expect(k.logs).toContain("agents/taken already has an agent.json; pick another name");
    expect(existsSync(join(k.root, "agents", "fresh", "agent.json"))).toBe(true);
    expect(k.logs.join("\n")).toContain("taskfast init did not finish.");
    expect(k.ran.map((r) => r.cmd)).toEqual(["taskfast"]);
  });
});

describe("command line", () => {
  it("reads every flag, repeated --set and --no-init", () => {
    expect(parseSetupArgs(["--env", "staging", "--provider", "openai", "--set", "A=1", "--set", "B", "--model", "m", "--agent", "x", "--role", "both", "--name", "n", "--business", "b", "--description", "d", "--goals", "g", "--budget", "5", "--no-init"])).toEqual({
      env: "staging", provider: "openai", set: ["A=1", "B"], model: "m", agent: "x", role: "both", name: "n", business: "b", description: "d", goals: "g", budget: "5", init: false,
    });
    expect(parseSetupArgs(["--init"]).init).toBe(true);
    expect(() => parseSetupArgs(["--envv", "staging"])).toThrow(/Unknown option '--envv'/);
  });
  it("maps only the kit environment names to TaskFast", () => {
    expect(["production", "staging", "development"].map(taskfastEnv)).toEqual(["prod", "staging", "local"]);
    for (const other of ["dev", "prod", "local"]) expect(() => taskfastEnv(other)).toThrow(/--env must be/);
  });
});

describe("upsertEnv", () => {
  it("replaces or appends a line, preserving the rest", () => {
    expect(upsertEnv("A=1\nB=2\n", "A", "9")).toBe("A=9\nB=2\n");
    expect(upsertEnv("A=1", "B", "2")).toBe("A=1\nB=2\n");
    expect(upsertEnv("", "B", "2")).toBe("B=2\n");
  });
  it.each(["a b", "a#b", 'a"b', "", "a\\b", "a\nb"])("refuses value %j without printing it", (v) => {
    expect(() => upsertEnv("", "K", v)).toThrow(/must not contain/);
  });
});

describe("provider catalogue", () => {
  it("offers supported native factories and aliases only, with every entry at the shared installed package pin", () => {
    const ids = CATALOGUE.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 4)).toEqual(["anthropic", "openai", "google", "moonshotai"]);
    expect(ids).toEqual(expect.arrayContaining(["openrouter", "ollama", "gateway", "togetherai", "amazon-bedrock", "google-vertex", "mistral", "xai", "deepseek"]));
    const pins = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).dependencies;
    for (const p of CATALOGUE) {
      const source = providerSource(p.id);
      expect(p.package).toBe("@earendil-works/pi-ai");
      expect(p.version).toBe(pins[p.package]);
      expect(installedVersion(ROOT, p.package)).toBe(p.version);
      expect(source).toMatchObject({ package: p.package, export: p.export, version: p.version, nativeId: p.nativeId });
      if (p.defaultModel) {
        expect(p.models).toContain(p.defaultModel);
        expect(splitModel(`${p.id}:${p.defaultModel}`).provider).toBe(p.id);
      } else expect(p.id).toBe("ollama");
      for (const s of p.settings) expect(s.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      for (const group of p.authAlternatives) for (const name of group) expect(p.settings.map((s) => s.name)).toContain(name);
    }
  });

  it("documents all former providers and explicitly records unsupported entries", () => {
    const docs = readFileSync(join(ROOT, "docs", "providers.md"), "utf8");
    const catalog = JSON.parse(readFileSync(join(ROOT, "providers.json"), "utf8"));
    for (const id of ["anthropic", "openai", "google", "moonshotai", "xai", "deepseek", "mistral", "groq", "openrouter", "ollama", "gateway", "alibaba", "amazon-bedrock", "anthropic-aws", "azure", "baseten", "cerebras", "cohere", "deepinfra", "fireworks", "gmicloud", "google-vertex", "huggingface", "minimax", "togetherai", "zai"]) expect(docs).toContain(`| \`${id}\` |`);
    for (const id of ["alibaba", "anthropic-aws", "cohere", "deepinfra", "gmicloud"]) {
      expect(CATALOGUE.some((p) => p.id === id)).toBe(false);
      expect(catalog.unsupported).toContainEqual({ id, reason: expect.any(String) });
      expect(docs).toContain(`| \`${id}\` | Unsupported:`);
    }
  });

  function generatorKit() {
    const root = kit([]).root;
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "src", "core"), { recursive: true });
    cpSync(join(ROOT, "scripts", "gen-providers.mjs"), join(root, "scripts", "gen-providers.mjs"));
    return root;
  }
  it("regenerates exactly from the installed pin without network or package commands", () => {
    const root = generatorKit();
    execFileSync(process.execPath, [join(root, "scripts", "gen-providers.mjs")], { cwd: root, env: { PATH: "", HOME: root }, stdio: "pipe" });
    for (const path of ["providers.json", "src/core/providers.ts", "docs/providers.md"]) expect(readFileSync(join(root, path), "utf8")).toBe(readFileSync(join(ROOT, path), "utf8"));
  });
  it("refuses unrecorded losses before rewriting any generated output", () => {
    const root = generatorKit();
    const catalog = JSON.parse(readFileSync(join(root, "providers.json"), "utf8"));
    catalog.providers.push({ ...entry("anthropic"), id: "unexpected-old-provider" });
    writeFileSync(join(root, "providers.json"), JSON.stringify(catalog));
    writeFileSync(join(root, "src", "core", "providers.ts"), "unchanged");
    const before = readFileSync(join(root, "providers.json"), "utf8");
    const result = spawnSync(process.execPath, [join(root, "scripts", "gen-providers.mjs")], { cwd: root, env: { PATH: "", HOME: root }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Catalogue not written");
    expect(readFileSync(join(root, "providers.json"), "utf8")).toBe(before);
    expect(readFileSync(join(root, "src", "core", "providers.ts"), "utf8")).toBe("unchanged");
  });
});
