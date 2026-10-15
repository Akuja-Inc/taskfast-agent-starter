import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { providerSource } from "../src/core/model.js";
import { loadSkills } from "../src/core/skills.js";
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

// The real bundle `taskfast skills --yes` writes; see test/fixtures/cli/README.md.
const BUNDLE = join(ROOT, "test/fixtures/cli/skills/taskfast-agent");
// A stand-in taskfast CLI: --version, and `skills --yes`, which writes the real capture to
// both folders the CLI writes, under its working directory.
function fakeCli(cmd: string, args: string[], cwd: string): { status: number; stdout: string } {
  if (cmd !== "taskfast") return { status: 127, stdout: "" };
  if (args[0] === "--version") return { status: 0, stdout: "taskfast 0.19.7\n" };
  for (const folder of [".agents", ".claude"]) cpSync(BUNDLE, join(cwd, folder, "skills/taskfast-agent"), { recursive: true });
  return { status: 0, stdout: '{"ok":true}\n' };
}

function kit(answers: string[], opts: { env?: NodeJS.ProcessEnv; envFile?: string; agentEnv?: { id: string; text: string }; runStatus?: number; capture?: SetupIO["capture"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kit-"));
  writeFileSync(join(root, "package.json"), readFileSync(join(ROOT, "package.json")));
  cpSync(join(ROOT, "examples"), join(root, "examples"), { recursive: true });
  cpSync(join(ROOT, "providers.json"), join(root, "providers.json"));
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  if (opts.envFile !== undefined) writeFileSync(join(root, ".env"), opts.envFile);
  if (opts.agentEnv) {
    mkdirSync(join(root, "agents", opts.agentEnv.id), { recursive: true });
    writeFileSync(join(root, "agents", opts.agentEnv.id, ".env"), opts.agentEnv.text);
  }
  const asked: { question: string; hidden: boolean }[] = [];
  const ran: { cmd: string; args: string[]; cwd: string }[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const captured: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const logs: string[] = [];
  const io: SetupIO = {
    root, env: opts.env ?? {},
    ask: async (question, hidden = false) => {
      asked.push({ question, hidden });
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`no scripted answer for: ${question}`);
      return answer;
    },
    run: (cmd, args, cwd, env) => (ran.push({ cmd, args, cwd }), envs.push(env), opts.runStatus ?? 0),
    capture: (cmd, args, cwd, env) => (captured.push({ cmd, args, cwd, env }), (opts.capture ?? fakeCli)(cmd, args, cwd, env)),
    log: (line) => void logs.push(line),
  };
  const agent = (id: string) => JSON.parse(readFileSync(join(root, "agents", id, "agent.json"), "utf8"));
  const instructions = (id: string) => readFileSync(join(root, "agents", id, "INSTRUCTIONS.md"), "utf8");
  return { root, io, asked, ran, envs, captured, logs, agent, instructions, run: (o: SetupOptions = {}) => setup(io, o), env: (id = "flagged") => readFileSync(existsSync(join(root, "agents", id, ".env")) ? join(root, "agents", id, ".env") : join(root, ".env"), "utf8") };
}
const ME = ["Ada Lovelace", "Ada Analytics", "Data clean-up for small charities."];
// Running init asks for a wallet password; an empty answer skips it.
const worker = (init = "n") => ["1", ...ME, "", init, ...(/^n/i.test(init) ? [] : [""])];
const ALL: SetupOptions = {
  provider: "anthropic", set: ["ANTHROPIC_API_KEY=sk-ant-flag"], model: "claude-sonnet-5-5", agent: "flagged", role: "poster",
  name: ME[0], business: ME[1], description: ME[2], goals: "hire well", budget: "40", init: true,
};

describe("setup", () => {
  it("keeps two agents' provider credentials inside their own folders without changing root settings", async () => {
    const k = kit([], { env: { ANTHROPIC_API_KEY: "first-agent-key" }, envFile: "ROOT_SETTING=unchanged\n" });
    await k.run({ ...ALL, agent: "1", env: "staging", set: ["ANTHROPIC_API_KEY"], init: false });
    expect(existsSync(join(k.root, "agents", "1", ".env"))).toBe(true);
    await setup({ ...k.io, env: { ANTHROPIC_API_KEY: "second-agent-key" } }, { ...ALL, agent: "2", env: "staging", set: ["ANTHROPIC_API_KEY"], init: false });
    expect(readFileSync(join(k.root, "agents", "1", ".env"), "utf8")).toBe("ANTHROPIC_API_KEY=first-agent-key\n");
    expect(readFileSync(join(k.root, "agents", "2", ".env"), "utf8")).toBe("ANTHROPIC_API_KEY=second-agent-key\n");
    expect(readFileSync(join(k.root, ".env"), "utf8")).toBe("ROOT_SETTING=unchanged\n");
    expect(statSync(join(k.root, "agents", "1", ".env")).mode & 0o777).toBe(0o600);
    expect(k.logs.join("\n")).not.toContain("first-agent-key");
    expect(k.logs.join("\n")).not.toContain("second-agent-key");
  });
  it("refuses linked settings before reading or overwriting another folder's file", async () => {
    const k = kit([]);
    const dir = join(k.root, "agents", "flagged");
    mkdirSync(dir, { recursive: true });
    const outside = join(k.root, "other-settings");
    const text = "ANTHROPIC_API_KEY=synthetic-other-agent\n";
    writeFileSync(outside, text);
    symlinkSync(outside, join(dir, ".env"));
    await expect(k.run({ ...ALL, env: "staging" })).rejects.toThrow(/symlink/);
    expect(k.ran).toEqual([]);
    expect(existsSync(join(dir, "agent.json"))).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe(text);
  });

  it("initializes the wallet at a relative path inside the owning agent folder", async () => {
    const k = kit([]);
    await k.run({ ...ALL, env: "staging" });
    expect(k.ran.at(-1)).toEqual({ cmd: "taskfast", args: ["--env", "staging", "init", "--keystore-path=.taskfast/wallet.json"], cwd: join(k.root, "agents", "flagged") });
  });

  it("asks for a hidden, confirmed, long enough one-line wallet password, keeps its spaces and generates the wallet with it", async () => {
    const typed = "  typed pass phrase ";
    const k = kit(["", "two\nlines here", "short pass", typed, "typo pass phrase", typed, typed]);
    await k.run({ ...ALL, env: "staging", init: undefined });
    expect(k.asked.map((a) => a.hidden)).toEqual([false, true, true, true, true, true, true]);
    expect(k.asked.filter((a) => a.question.startsWith("Confirm"))).toHaveLength(2);
    expect(k.logs).toContain("The password must be one line.");
    expect(k.logs).toContain("The password must be at least 12 characters.");
    expect(k.logs).toContain("The passwords did not match. Enter it again.");
    expect(readFileSync(join(k.root, "agents", "flagged", ".taskfast", "wallet-password"), "utf8")).toBe(typed);
    expect(k.ran.at(-1)?.args.slice(-2)).toEqual(["--generate-wallet", "--wallet-password-file=.taskfast/wallet-password"]);
    expect(k.logs.join("\n")).not.toContain("typed pass");
  });

  it("keeps an existing wallet password file and never asks for another", async () => {
    const k = kit([], { env: { WALLET_PW: "replacement pass" } });
    const dir = join(k.root, "agents", "flagged", ".taskfast");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "wallet-password"), "original");
    await k.run({ ...ALL, env: "staging", walletPasswordEnv: "WALLET_PW" });
    expect(k.asked).toEqual([]);
    expect(readFileSync(join(dir, "wallet-password"), "utf8")).toBe("original");
    expect(k.ran.at(-1)?.args.at(-1)).toBe("--wallet-password-file=.taskfast/wallet-password");
  });

  it("does not generate a wallet over an existing wallet or TaskFast config", async () => {
    for (const existing of ["wallet.json", "config.json"]) {
      const k = kit([]);
      const dir = join(k.root, "agents", "flagged", ".taskfast");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "wallet-password"), "existing password");
      writeFileSync(join(dir, existing), "{}");
      await k.run({ ...ALL, env: "staging" });
      expect(k.ran.at(-1)?.args).toEqual(["--env", "staging", "init", "--keystore-path=.taskfast/wallet.json", "--wallet-password-file=.taskfast/wallet-password"]);
    }
  });

  it("hides TASKFAST_WALLET_PASSWORD from taskfast init so the wallet uses the password file", async () => {
    const k = kit([], { env: { TASKFAST_WALLET_PASSWORD: "shell password", WALLET_PW: "file password", PATH: "/usr/bin" } });
    await k.run({ ...ALL, env: "staging", walletPasswordEnv: "WALLET_PW" });
    expect(k.envs).toEqual([{ WALLET_PW: "file password", PATH: "/usr/bin" }]);
    expect(k.ran.at(-1)?.args.slice(-2)).toEqual(["--generate-wallet", "--wallet-password-file=.taskfast/wallet-password"]);
    expect(readFileSync(join(k.root, "agents", "flagged", ".taskfast", "wallet-password"), "utf8")).toBe("file password");
    expect(k.logs).toContain("taskfast init runs without TASKFAST_WALLET_PASSWORD, so the wallet uses agents/flagged/.taskfast/wallet-password as the agent does.");
    expect(k.logs.join("\n")).not.toContain("shell password");
    // Naming the variable makes its value the agent's password.
    const adopt = kit([], { env: { TASKFAST_WALLET_PASSWORD: "shell password" } });
    await adopt.run({ ...ALL, env: "staging", walletPasswordEnv: "TASKFAST_WALLET_PASSWORD" });
    expect(readFileSync(join(adopt.root, "agents", "flagged", ".taskfast", "wallet-password"), "utf8")).toBe("shell password");
    expect(adopt.envs[0]).not.toHaveProperty("TASKFAST_WALLET_PASSWORD");
  });

  it("writes the flagged password even when init is skipped, and asks nothing without the flag", async () => {
    const k = kit([], { env: { WALLET_PW: "later password" } });
    await k.run({ ...ALL, env: "staging", init: false, walletPasswordEnv: "WALLET_PW" });
    expect(readFileSync(join(k.root, "agents", "flagged", ".taskfast", "wallet-password"), "utf8")).toBe("later password");
    expect(k.logs.join("\n")).toContain("--wallet-password-file=.taskfast/wallet-password");
    await k.run({ ...ALL, agent: "plain", env: "staging" });
    expect(k.asked).toEqual([]);
    expect(existsSync(join(k.root, "agents", "plain", ".taskfast", "wallet-password"))).toBe(false);
  });

  it("refuses a missing --wallet-password-env variable before writing anything", async () => {
    const k = kit([]);
    await expect(k.run({ ...ALL, env: "staging", walletPasswordEnv: "WALLET_PW" })).rejects.toThrow(/--wallet-password-env: WALLET_PW: is not set in your environment/);
    await expect(setup({ ...k.io, env: { WALLET_PW: "too short" } }, { ...ALL, env: "staging", walletPasswordEnv: "WALLET_PW" })).rejects.toThrow(/WALLET_PW: must be at least 12 characters/);
    expect(existsSync(join(k.root, "agents", "flagged"))).toBe(false);
    expect(k.ran).toEqual([]);
  });

  it("asks for a hidden native key, saves privately, selects a catalog model and initializes production by default without installing", async () => {
    const k = kit(["1", "ada", "sk-ant-test123", "", ...worker("")]);
    await k.run();
    expect(k.env("ada")).toBe("ANTHROPIC_API_KEY=sk-ant-test123\n");
    expect(statSync(join(k.root, "agents", "ada", ".env")).mode & 0o777).toBe(0o600);
    expect(k.asked.filter((a) => a.hidden).map((a) => a.question)).toEqual([expect.stringContaining("ANTHROPIC_API_KEY"), expect.stringContaining("Wallet password")]);
    expect(k.agent("ada")).toEqual({ ...JSON.parse(readFileSync(join(ROOT, "examples", "careful-worker", "agent.json"), "utf8")), model: `anthropic:${entry("anthropic").defaultModel}` });
    expect(k.instructions("ada")).toBe(`You are ${ME[0]}, who runs ${ME[1]}. ${ME[2]}\n\nWhat you want right now: do a few jobs very well and earn repeat clients.\n`);
    expect(k.ran).toEqual([{ cmd: "taskfast", args: ["init", "--keystore-path=.taskfast/wallet.json"], cwd: join(k.root, "agents", "ada") }]);
    expect(k.logs).toContain("Environment: production (pass --env staging or --env development to change it)\n");
    expect(k.logs.join("\n")).not.toContain("sk-ant-test123");
  });

  it.each([
    ["staging", ["--env", "staging", "init", "--keystore-path=.taskfast/wallet.json"], "pnpm agents --env staging"],
    ["development", ["--env", "local", "init", "--keystore-path=.taskfast/wallet.json"], "pnpm agents --env development"],
    ["production", ["init", "--keystore-path=.taskfast/wallet.json"], "pnpm agents"],
  ])("uses --env %s without asking where the agent runs", async (env, args, next) => {
    const k = kit(["anthropic", "w", "sk-x", "", ...worker("")]);
    await k.run({ env });
    expect(k.asked).toHaveLength(11);
    expect(k.ran.at(-1)?.args).toEqual(args);
    expect(k.logs.join("\n")).toContain(next);
  });

  it("answers every question with flags, including --set NAME from the environment", async () => {
    const k = kit([], { env: { ANTHROPIC_API_KEY: "key-from-environment", WALLET_PW: "pass from env" } });
    await k.run({ ...ALL, set: ["ANTHROPIC_API_KEY"], env: "staging", walletPasswordEnv: "WALLET_PW" });
    expect(k.asked).toEqual([]);
    expect(k.env()).toBe("ANTHROPIC_API_KEY=key-from-environment\n");
    expect(k.agent("flagged")).toMatchObject({ role: "poster", model: "anthropic:claude-sonnet-5-5" });
    expect(k.agent("flagged")).not.toHaveProperty("character");
    expect(k.instructions("flagged")).toBe(`You are ${ME[0]}, who runs ${ME[1]}. ${ME[2]}\n\nWhat you want right now: hire well.\n\nYou have about $40 to spend on a single job.\n`);
    const password = join(k.root, "agents", "flagged", ".taskfast", "wallet-password");
    expect(readFileSync(password, "utf8")).toBe("pass from env");
    expect(statSync(password).mode & 0o777).toBe(0o400);
    expect(statSync(join(k.root, "agents", "flagged", ".taskfast")).mode & 0o777).toBe(0o700);
    expect(k.ran).toEqual([{ cmd: "taskfast", args: ["--env", "staging", "init", "--keystore-path=.taskfast/wallet.json", "--generate-wallet", "--wallet-password-file=.taskfast/wallet-password"], cwd: join(k.root, "agents", "flagged") }]);
    expect(k.logs.join("\n")).not.toContain("key-from-environment");
    expect(k.logs.join("\n")).not.toContain("pass from env");
  });

  it("asks only what flags leave out, with no provider install command", async () => {
    const k = kit([ME[2] ?? "description", ""], { env: { MOONSHOT_API_KEY: "mk-from-env" } });
    await k.run({ provider: "moonshotai", set: ["MOONSHOT_API_KEY"], model: "kimi-k3", agent: "half", role: "worker", name: ME[0], business: ME[1], init: false });
    expect(k.env("half")).toBe("MOONSHOT_API_KEY=mk-from-env\n");
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
    const k = kit(["anthropic", "w2", "sk-x", "", "1"]);
    await expect(k.run({ budget: "10" })).rejects.toThrow("--budget: a worker has no budget");
    expect(existsSync(join(k.root, "agents", "w2"))).toBe(false);
  });

  it("selects a model by number and asks a poster budget, with only TaskFast as a child command", async () => {
    const k = kit(["moonshotai", "shop", "mk-test", "2", "2", ...ME, "", "35", "", ""]);
    await k.run({ env: "staging" });
    expect(k.agent("shop")).toMatchObject({ role: "poster", model: `moonshotai:${entry("moonshotai").models[1]}` });
    expect(k.instructions("shop")).toContain("You have about $35 to spend on a single job.");
    expect(k.ran).toEqual([{ cmd: "taskfast", args: ["--env", "staging", "init", "--keystore-path=.taskfast/wallet.json"], cwd: join(k.root, "agents", "shop") }]);
  });

  it("Bedrock defaults to one bearer token instead of demanding AWS key pairs", async () => {
    const k = kit(["amazon-bedrock", "bed", "bedrock-test-token", "", ...worker()]);
    await k.run();
    expect(k.env("bed")).toBe("AWS_BEARER_TOKEN_BEDROCK=bedrock-test-token\n");
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
      const file = join(k.root, "agents", "flagged", "service-account.json");
      mkdirSync(join(k.root, "agents", "flagged"), { recursive: true });
      writeFileSync(file, "{}");
      values.push(`GOOGLE_APPLICATION_CREDENTIALS=${file}`);
    }
    if (provider === "amazon-bedrock") {
      await expect(k.run({ ...ALL, provider, set: values, model: entry(provider).defaultModel, init: false })).rejects.toThrow("folder-scoped Bedrock requires");
      expect(existsSync(join(k.root, "agents", "flagged", ".env"))).toBe(false);
      return;
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
    const file = join(partial.root, "agents", "flagged", "service-account.json");
    mkdirSync(join(partial.root, "agents", "flagged"), { recursive: true });
    writeFileSync(file, "{}");
    await partial.run({ ...ALL, provider: "google-vertex", set: [`GOOGLE_APPLICATION_CREDENTIALS=${file}`], model: entry("google-vertex").defaultModel, init: false });
    expect(partial.asked.map((p) => p.question)).toEqual([expect.stringContaining("GOOGLE_CLOUD_LOCATION"), expect.stringContaining("GOOGLE_CLOUD_PROJECT")]);
    expect(partial.env()).not.toContain("GOOGLE_CLOUD_API_KEY=");
  });

  it("a partial AWS key pair asks for only the missing secret, with echo hidden", async () => {
    const k = kit(["missing-secret"]);
    await expect(k.run({ ...ALL, provider: "amazon-bedrock", set: ["AWS_ACCESS_KEY_ID=access"], model: entry("amazon-bedrock").defaultModel, init: false })).rejects.toThrow("folder-scoped Bedrock requires");
    expect(k.asked).toEqual([{ question: expect.stringContaining("AWS_SECRET_ACCESS_KEY"), hidden: true }]);
    expect(existsSync(join(k.root, "agents", "flagged", ".env"))).toBe(false);
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
    const k = kit(["ollama", "local", "", "qwen3:8b", ...worker()]);
    await k.run({ env: "development" });
    expect(k.logs).toContain("A model id is needed.");
    expect(existsSync(join(k.root, ".env"))).toBe(false);
    expect(k.agent("local").model).toBe("ollama:qwen3:8b");
    expect(k.ran).toEqual([]);
  });

  it("keeps existing keys and other .env lines but hardens an existing file to 0600", async () => {
    const k = kit(["openai", "a1", "", "3", ...ME, "", "", "n"], { agentEnv: { id: "a1", text: "OTHER=1\nOPENAI_API_KEY=sk-old\n" } });
    await k.run({ env: "staging" });
    expect(k.env("a1")).toBe("OTHER=1\nOPENAI_API_KEY=sk-old\n");
    expect(statSync(join(k.root, "agents", "a1", ".env")).mode & 0o777).toBe(0o600);
    expect(k.asked.some((a) => a.question.includes("OPENAI_API_KEY"))).toBe(false);
    expect(k.logs.join("\n")).not.toContain("sk-old");
    expect(k.agent("a1").role).toBe("both");
    expect(k.ran).toEqual([]);
  });

  it("replaces an existing agent value with --set, and saves required shell keys inside the folder", async () => {
    const k = kit([], { agentEnv: { id: "flagged", text: "OPENAI_API_KEY=sk-old\n" } });
    await k.run({ ...ALL, provider: "openai", set: ["OPENAI_API_KEY=sk-new"], model: "gpt-5-mini", init: false });
    expect(k.env()).toBe("OPENAI_API_KEY=sk-new\n");
    const shell = kit([], { env: { OPENAI_API_KEY: "shell-only" } });
    await shell.run({ ...ALL, provider: "openai", set: [], model: "gpt-5-mini", init: false });
    expect(shell.asked).toEqual([]);
    expect(shell.env()).toBe("OPENAI_API_KEY=shell-only\n");
    expect(existsSync(join(shell.root, ".env"))).toBe(false);
    expect(shell.logs.join("\n")).not.toContain("shell-only");
  });

  it("reprompts wrong choices, stale models, taken folders and bad keys; describes failed init", async () => {
    const k = kit(["0", "nosuch", "anthropic", "taken", "notes", "fresh", "has space", "sk-ok", "not-in-the-pin", "", "1", ...ME, "", "", ""], { runStatus: 1 });
    mkdirSync(join(k.root, "agents", "taken"), { recursive: true });
    writeFileSync(join(k.root, "agents", "taken", "agent.json"), "{}");
    mkdirSync(join(k.root, "agents", "notes"), { recursive: true });
    writeFileSync(join(k.root, "agents", "notes", "INSTRUCTIONS.md"), "someone's instructions");
    await k.run();
    expect(k.logs.filter((l) => l === `Enter a number from 1 to ${CATALOGUE.length}.`)).toHaveLength(2);
    expect(k.logs).toContain("that value has spaces, quotes, backslashes or #");
    expect(k.logs).toContain("agents/taken already has an agent.json; pick another name");
    expect(k.logs).toContain("agents/notes already has an INSTRUCTIONS.md; pick another name");
    expect(readFileSync(join(k.root, "agents", "notes", "INSTRUCTIONS.md"), "utf8")).toBe("someone's instructions");
    expect(existsSync(join(k.root, "agents", "fresh", "agent.json"))).toBe(true);
    expect(k.logs.join("\n")).toContain("taskfast init did not finish.");
    expect(k.ran.map((r) => r.cmd)).toEqual(["taskfast"]);
  });
});

describe("--taskfast-skill", () => {
  const skillDir = (root: string) => join(root, "agents", "flagged", ".agents/skills/taskfast-agent");
  it("exports the CLI's skill in a throwaway folder and publishes only the .agents copy, with its provenance", async () => {
    const k = kit([], { env: { PATH: "/usr/bin", HOME: "/home/someone", TASKFAST_API_KEY: "secret-key" } });
    await k.run({ ...ALL, env: "staging", init: false, taskfastSkill: true });
    const [version, exported] = k.captured;
    expect(k.captured.map(({ cmd, args }) => [cmd, ...args.map((arg) => arg.replace(version!.cwd, "<tmp>"))])).toEqual([
      ["taskfast", "--version"], ["taskfast", "--config=<tmp>/absent.json", "--no-trace", "skills", "--yes"],
    ]);
    // An empty home and no TaskFast key or config: the export reads no account.
    expect(exported!.env).toEqual({ PATH: "/usr/bin", HOME: version!.cwd });
    expect(exported!.cwd).toBe(version!.cwd);
    expect(existsSync(version!.cwd)).toBe(false);
    for (const file of ["SKILL.md", ...readdirSync(join(BUNDLE, "reference")).map((name) => `reference/${name}`)]) {
      expect(readFileSync(join(skillDir(k.root), file), "utf8")).toBe(readFileSync(join(BUNDLE, file), "utf8"));
    }
    expect(readdirSync(join(k.root, "agents", "flagged", ".agents")).sort()).toEqual(["provenance.json", "skills"]);
    expect(existsSync(join(k.root, "agents", "flagged", ".claude"))).toBe(false);
    const provenance = JSON.parse(readFileSync(join(k.root, "agents", "flagged", ".agents/provenance.json"), "utf8"));
    expect(provenance["taskfast-agent"]).toMatchObject({ source: "taskfast-cli", version: "0.19.7", files: { "SKILL.md": "8732dbba4a8bcb781a9055adfab44cd945b3799e51806798b9db0fdcb312b7a7" } });
    expect(Object.keys(provenance["taskfast-agent"].files)).toHaveLength(7);
    expect(loadSkills(join(k.root, "agents", "flagged")).map((skill) => skill.name)).toEqual(["taskfast-agent"]);
    expect(k.logs).toContain("Added the taskfast-agent skill from taskfast 0.19.7 to agents/flagged/.agents/skills (file hashes in .agents/provenance.json)");
  });
  it("never runs the export without the flag", async () => {
    const k = kit([]);
    await k.run({ ...ALL, env: "staging", init: false });
    expect(k.captured).toEqual([]);
    expect(existsSync(join(k.root, "agents", "flagged", ".agents"))).toBe(false);
  });
  const failures: { name: string; capture: SetupIO["capture"]; error: RegExp }[] = [
    { name: "a missing CLI", capture: () => ({ status: 127, stdout: "" }), error: /taskfast skills did not finish/ },
    { name: "a failed export", capture: (cmd, args, cwd, env) => args[0] === "--version" ? fakeCli(cmd, args, cwd) : { status: 1, stdout: "" }, error: /taskfast skills did not finish/ },
    { name: "an export with no skill", capture: (cmd, args, cwd) => args[0] === "--version" ? fakeCli(cmd, args, cwd) : { status: 0, stdout: "" }, error: /exported no skill, not taskfast-agent/ },
    { name: "an invalid bundle", capture: (cmd, args, cwd) => {
      const result = fakeCli(cmd, args, cwd);
      if (args[0] !== "--version") symlinkSync("/etc/passwd", join(cwd, ".agents/skills/taskfast-agent/reference/passwd.md"));
      return result;
    }, error: /passwd\.md is a symlink/ },
  ];
  it.each(failures)("stops on $name before writing any agent file", async ({ capture, error }) => {
    const k = kit([], { capture });
    await expect(k.run({ ...ALL, env: "staging", taskfastSkill: true })).rejects.toThrow(error);
    expect(existsSync(join(k.root, "agents", "flagged"))).toBe(false);
    expect(k.ran).toEqual([]);
  });
  it("never replaces a skill already in the agent folder", async () => {
    const k = kit([]);
    mkdirSync(skillDir(k.root), { recursive: true });
    writeFileSync(join(skillDir(k.root), "SKILL.md"), "owner edits\n");
    await expect(k.run({ ...ALL, env: "staging", taskfastSkill: true })).rejects.toThrow(/agents\/flagged\/.agents\/skills\/taskfast-agent already exists; setup never replaces a skill/);
    expect(readFileSync(join(skillDir(k.root), "SKILL.md"), "utf8")).toBe("owner edits\n");
    expect(k.captured).toEqual([]);
    expect(existsSync(join(k.root, "agents", "flagged", "agent.json"))).toBe(false);
  });
});

describe("command line", () => {
  it("reads every flag, repeated --set and --no-init", () => {
    expect(parseSetupArgs(["--env", "staging", "--provider", "openai", "--set", "A=1", "--set", "B", "--model", "m", "--agent", "x", "--role", "both", "--name", "n", "--business", "b", "--description", "d", "--goals", "g", "--budget", "5", "--wallet-password-env", "PW", "--no-init"])).toEqual({
      env: "staging", provider: "openai", set: ["A=1", "B"], model: "m", agent: "x", role: "both", name: "n", business: "b", description: "d", goals: "g", budget: "5", walletPasswordEnv: "PW", init: false,
    });
    expect(parseSetupArgs(["--init"]).init).toBe(true);
    expect(parseSetupArgs(["--taskfast-skill"]).taskfastSkill).toBe(true);
    expect(parseSetupArgs(["--no-taskfast-skill"]).taskfastSkill).toBe(false);
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
