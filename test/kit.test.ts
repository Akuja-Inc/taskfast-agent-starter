import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerSettings } from "../src/core/folder.js";
import { describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentHandle } from "../src/run.js";
import { parseAgentSpec } from "../src/core/spec.js";
import { runAgents } from "../src/run.js";
import { copyExample, example } from "./example.js";

const ROOT = join(import.meta.dirname, "..");

it("uses the manifest as the single pnpm version source in CI", () => {
  const manifest: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  if (typeof manifest !== "object" || manifest === null || !("packageManager" in manifest)) throw new Error("package manager pin missing");
  expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const options = workflow.match(/uses: pnpm\/action-setup@[^\n]+\n\s+with:\n((?:[ \t]{10}.+\n)+)/)?.[1];
  expect(options).toBeDefined();
  expect(options).not.toMatch(/\bversion:/);
});

it("builds plain-Node fixtures before workers, not independently inside suites", () => {
  expect(readFileSync(join(ROOT, "vitest.config.ts"), "utf8")).toContain('globalSetup: ["test/build.ts"]');
  for (const file of ["runtime-crash.test.ts", "setup-terminal.test.ts"]) {
    const suite = readFileSync(join(ROOT, "test", file), "utf8");
    expect(suite).not.toMatch(/\b(?:execFileSync|spawnSync)\([^;]*(?:tsconfig\.build\.json|["']build["'])/s);
  }
});

describe("examples", () => {
  it.each(readdirSync(join(ROOT, "examples")))("%s is a valid agent folder", (name) => {
    expect(parseAgentSpec(example(name)).instructions).toMatch(/^You are /);
  });
});

describe("runAgents", () => {
  function agents(withConfig: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    mkdirSync(join(dir, "me", ".taskfast"), { recursive: true });
    copyExample("careful-worker", join(dir, "me"));
    if (withConfig) writeFileSync(join(dir, "me", ".taskfast", "config.json"), "{}");
    mkdirSync(join(dir, "notes")); // no agent.json: not an agent
    return dir;
  }

  it("opens each agent with its own config, then pings and closes it", async () => {
    const dir = agents(true);
    const calls: unknown[] = [];
    const stop = new AbortController();
    const agent: AgentHandle = {
      closed: Promise.resolve({ reason: "closed" }),
      deliver: async () => {},
      ping: async () => (calls.push(["ping"]), stop.abort()),
      close: async () => void calls.push(["close"]),
    };
    await runAgents({ agentsDir: dir, env: "staging", openAgent: async ({ runtime: rt }) => { calls.push(["open", rt]); return agent; }, listen: () => ({ close: async () => {} }), signal: stop.signal, log: () => {} });
    expect(calls).toEqual([["open", { env: "staging", configPath: join(dir, "me", ".taskfast", "config.json") }], ["ping"], ["close"]]);
  });

  it("preserves a healthy nonconsole agent when another folder is malformed", async () => {
    const dir = agents(true);
    mkdirSync(join(dir, "broken"));
    writeFileSync(join(dir, "broken", "agent.json"), "not JSON");
    const stop = new AbortController();
    const calls: string[] = [];
    await runAgents({ agentsDir: dir, env: "staging", signal: stop.signal, log: () => {}, listen: () => ({ close: async () => {} }), openAgent: async ({ id }) => {
      calls.push(`open ${id}`);
      return { closed: Promise.resolve({ reason: "closed" }), deliver: async () => {}, ping: async () => { calls.push(`ping ${id}`); stop.abort(); }, close: async () => { calls.push(`close ${id}`); } };
    } });
    expect(calls).toEqual(["open me", "ping me", "close me"]);
  });

  it("fails nonconsole startup only when all independent openings fail", async () => {
    const dir = agents(true);
    const logs: string[] = [];
    await expect(runAgents({ agentsDir: dir, env: "staging", signal: new AbortController().signal, log: (line) => logs.push(line), openAgent: async () => { throw new Error("offline fixture"); } })).rejects.toThrow("no agents opened: me: offline fixture");
    expect(logs).toContain("me: stopped: offline fixture");
  });

  it("aborts pending openings at shutdown and drains late handles before returning", async () => {
    const dir = agents(true);
    const stop = new AbortController();
    let openingSignal: AbortSignal | undefined;
    let releaseOpen = () => {};
    let releaseClose = () => {};
    const opening = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const closing = new Promise<void>((resolve) => { releaseClose = resolve; });
    const calls: string[] = [];
    let returned = false;
    const run = runAgents({ agentsDir: dir, env: "staging", signal: stop.signal, log: () => {}, listen: () => { calls.push("listen"); return { close: async () => {} }; }, openAgent: async ({ signal }) => {
      openingSignal = signal;
      calls.push("opening");
      await opening;
      return { closed: Promise.resolve({ reason: "closed" }), deliver: async () => {}, ping: async () => { calls.push("ping"); }, close: async () => { calls.push("closing"); await closing; calls.push("closed"); } };
    } }).then(() => { returned = true; });
    try {
      await expect.poll(() => calls).toEqual(["opening"]);
      stop.abort();
      expect(openingSignal?.aborted).toBe(true);
      expect(returned).toBe(false);
      releaseOpen();
      await expect.poll(() => calls).toEqual(["opening", "closing"]);
      expect(returned).toBe(false);
      releaseClose();
      await run;
      expect(calls).toEqual(["opening", "closing", "closed"]);
    } finally { stop.abort(); releaseOpen(); releaseClose(); await run; }
  });

  it("stops every ready event stream before draining a hung sibling at shutdown", async () => {
    const dir = agents(true);
    mkdirSync(join(dir, "two", ".taskfast"), { recursive: true });
    copyExample("careful-worker", join(dir, "two"));
    writeFileSync(join(dir, "two", ".taskfast", "config.json"), "{}");
    const stop = new AbortController();
    let release = () => {};
    const opening = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const run = runAgents({ agentsDir: dir, env: "staging", signal: stop.signal, log: () => {},
      listen: () => { calls.push("listen two"); return { close: async () => { calls.push("stop stream two"); } }; },
      openAgent: async ({ id }) => {
        if (id === "me") await opening;
        return { closed: Promise.resolve({ reason: "closed" }), deliver: async () => {}, ping: async () => {}, close: async () => { calls.push(`close ${id}`); } };
      },
    });
    try {
      await expect.poll(() => calls).toEqual(["listen two"]);
      stop.abort();
      await expect.poll(() => calls).toEqual(["listen two", "stop stream two"]);
      release();
      await run;
      expect(calls).toEqual(["listen two", "stop stream two", "close me", "close two"]);
    } finally { stop.abort(); release(); await run; }
  });

  it("polls each ready agent independently without overlapping its own pings", async () => {
    const dir = agents(true);
    mkdirSync(join(dir, "two", ".taskfast"), { recursive: true });
    copyExample("careful-worker", join(dir, "two"));
    writeFileSync(join(dir, "two", ".taskfast", "config.json"), "{}");
    const stop = new AbortController();
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const counts = { me: 0, two: 0 };
    const run = runAgents({ agentsDir: dir, env: "staging", signal: stop.signal, pingEveryMs: 5, log: () => {}, listen: () => ({ close: async () => {} }), openAgent: async ({ id }) => ({
      closed: Promise.resolve({ reason: "closed" }), deliver: async () => {}, close: async () => { release(); },
      ping: async () => {
        if (id === "me") { counts.me++; await held; }
        else { counts.two++; await sleep(2); }
      },
    }) });
    try {
      await expect.poll(() => counts.two).toBeGreaterThanOrEqual(3);
      expect(counts.me).toBe(1);
    } finally { stop.abort(); release(); await run; }
  });

  it("keeps every agent's store and unlock path in its own folder", async () => {
    const dir = agents(true);
    mkdirSync(join(dir, "two", ".taskfast"), { recursive: true });
    copyExample("careful-worker", join(dir, "two"));
    writeFileSync(join(dir, "two", ".taskfast", "config.json"), "{}");
    for (const id of ["me", "two"]) writeFileSync(join(dir, id, ".taskfast", "wallet-password"), "simulated user-owned file", { mode: 0o400 });
    const opened: { id: string; storePath: string; file: string | undefined }[] = [];
    const stop = new AbortController();
    await runAgents({ agentsDir: dir, env: "staging", signal: stop.signal, log: () => {}, listen: () => ({ close: async () => {} }), openAgent: async ({ id, storePath, runtime }) => {
      opened.push({ id, storePath, file: runtime.walletPasswordFile });
      return { closed: Promise.resolve({ reason: "closed" }), deliver: async () => {}, ping: async () => { stop.abort(); }, close: async () => {} };
    } });
    expect(opened).toEqual(["me", "two"].map((id) => ({ id, storePath: join(dir, id, ".pi-state", "staging", "state.sqlite"), file: join(dir, id, ".taskfast", "wallet-password") })));
  });

  it.each(["root", "state"])("refuses a linked agent %s before opening any store", async (target) => {
    const root = mkdtempSync(join(tmpdir(), "linked-agent-"));
    const dir = join(root, "agents");
    const real = target === "root" ? join(root, "outside") : join(dir, "me");
    mkdirSync(join(real, ".taskfast"), { recursive: true });
    copyExample("careful-worker", real);
    writeFileSync(join(real, ".taskfast", "config.json"), "{}");
    if (target === "root") { mkdirSync(dir); symlinkSync(real, join(dir, "me")); }
    else { mkdirSync(join(root, "outside")); symlinkSync(join(root, "outside"), join(real, ".pi-state")); }
    let opens = 0;
    await expect(runAgents({ agentsDir: dir, env: "staging", signal: AbortSignal.abort(), log: () => {}, openAgent: async () => {
      opens++;
      return { closed: Promise.resolve({ reason: "closed" }), deliver: async () => {}, ping: async () => {}, close: async () => {} };
    } })).rejects.toThrow(/symlink/);
    expect(opens).toBe(0);
  });

  it("refuses the prior shared store location before opening any agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "prior-agent-store-"));
    const dir = join(root, "agents");
    mkdirSync(join(dir, "me", ".taskfast"), { recursive: true });
    copyExample("careful-worker", join(dir, "me"));
    writeFileSync(join(dir, "me", ".taskfast", "config.json"), "{}");
    const prior = join(root, ".pi-state", "staging", "me", "state.sqlite");
    mkdirSync(join(prior, ".."), { recursive: true });
    writeFileSync(prior, "simulated permanent history");
    let opens = 0;
    await expect(runAgents({ agentsDir: dir, env: "staging", signal: AbortSignal.abort(), log: () => {}, openAgent: async () => {
      opens++;
      return { closed: Promise.resolve({ reason: "closed" }), deliver: async () => {}, ping: async () => {}, close: async () => {} };
    } })).rejects.toThrow(/prior.*store|previous.*store/);
    expect(opens).toBe(0);
    expect(readFileSync(prior, "utf8")).toBe("simulated permanent history");
    expect(() => statSync(join(dir, "me", ".pi-state"))).toThrow();
  });

  it.each(["external", "absolute-inside", "escaped", "linked", "cancelled-link", "empty", "invalid"])("refuses a nonportable wallet reference %s before any agent opens", async (kind) => {
    const dir = agents(true);
    const home = join(dir, "me");
    const outside = join(dir, "other-wallet.json");
    const inside = join(home, ".taskfast", "wallet.json");
    writeFileSync(outside, "synthetic wallet outside");
    writeFileSync(inside, "synthetic wallet inside");
    symlinkSync(outside, join(home, "linked-wallet.json"));
    mkdirSync(join(dir, "nested"));
    symlinkSync(join(dir, "nested"), join(home, "parent-link"));
    const references: Record<string, unknown> = { external: outside, "absolute-inside": inside, escaped: "../other-wallet.json", linked: "linked-wallet.json", "cancelled-link": "parent-link/../other-wallet.json", empty: "", invalid: 42 };
    writeFileSync(join(home, ".taskfast", "config.json"), JSON.stringify({ keystore_path: references[kind] }));
    let opens = 0;
    await expect(runAgents({ agentsDir: dir, env: "staging", signal: AbortSignal.abort(), log: () => {}, listen: () => ({ close: async () => {} }), openAgent: async () => {
      opens++;
      return { closed: Promise.resolve({ reason: "closed" }), deliver: async () => {}, ping: async () => {}, close: async () => {} };
    } })).rejects.toThrow(/relative|inside the agent folder|symlink/);
    expect(opens).toBe(0);
    expect(readFileSync(outside, "utf8")).toBe("synthetic wallet outside");
    expect(() => statSync(join(home, ".pi-state"))).toThrow();
  });

  it("refuses an absolute persisted provider-file reference without rewriting private settings", () => {
    const dir = agents(true);
    const home = join(dir, "me");
    const credential = join(home, "provider-key.json");
    writeFileSync(credential, "synthetic provider credential");
    const settings = `GOOGLE_APPLICATION_CREDENTIALS=${credential}\n`;
    writeFileSync(join(home, ".env"), settings);
    expect(() => providerSettings(home)).toThrow(/relative/);
    expect(readFileSync(join(home, ".env"), "utf8")).toBe(settings);
    writeFileSync(join(home, ".env"), "GOOGLE_APPLICATION_CREDENTIALS=provider-key.json\n");
    expect(providerSettings(home)).toEqual({ GOOGLE_APPLICATION_CREDENTIALS: "provider-key.json" });
  });

  it("refuses an agent that has not run taskfast init", async () => {
    const run = runAgents({ agentsDir: agents(false), env: "prod", signal: AbortSignal.abort(), log: () => {} });
    await expect(run).rejects.toThrow(/taskfast --env prod init/);
  });

  it("refuses an agent without INSTRUCTIONS.md before opening any store, and warns about then ignores a stale character", async () => {
    const missing = agents(true);
    rmSync(join(missing, "me", "INSTRUCTIONS.md"));
    let opens = 0;
    const openAgent = async (): Promise<AgentHandle> => { opens++; throw new Error("must not open"); };
    await expect(runAgents({ agentsDir: missing, env: "staging", openAgent, signal: AbortSignal.abort(), log: () => {} })).rejects.toThrow(/me: no .*INSTRUCTIONS\.md; write the agent's instructions there/);
    const stale = agents(true);
    const file = JSON.parse(readFileSync(join(stale, "me", "agent.json"), "utf8"));
    writeFileSync(join(stale, "me", "agent.json"), JSON.stringify({ ...file, character: { name: "Old" } }));
    expect(opens).toBe(0);
    const logs: string[] = [];
    let spec: unknown;
    const stop = new AbortController();
    await runAgents({ agentsDir: stale, env: "staging", signal: stop.signal, log: (line) => void logs.push(line), listen: () => ({ close: async () => {} }),
      openAgent: async (agent) => { spec = agent.spec; stop.abort(); return { closed: new Promise(() => {}), deliver: async () => {}, ping: async () => {}, close: async () => {} }; } });
    expect(logs).toContain("me: agent.json still has character, which is ignored now; write the agent's name, business, goals and budget in INSTRUCTIONS.md in your own words, then remove character");
    expect(spec).toEqual({ ...file, instructions: example("careful-worker").instructions });
  });

  it("refuses an empty agents directory", async () => {
    const run = runAgents({ agentsDir: join(tmpdir(), "no-such-agents"), env: "prod", signal: AbortSignal.abort(), log: () => {} });
    await expect(run).rejects.toThrow(/no agents/);
  });
});
