import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentHandle } from "../src/run.js";
import { parseAgentSpec } from "../src/core/spec.js";
import { runAgents } from "../src/run.js";

const ROOT = join(import.meta.dirname, "..");
const example = (name: string): unknown => JSON.parse(readFileSync(join(ROOT, "examples", name), "utf8"));

describe("examples", () => {
  it.each(readdirSync(join(ROOT, "examples")))("%s is a valid agent file", (name) => {
    expect(parseAgentSpec(example(name)).character.name).toBeTruthy();
  });
});

describe("runAgents", () => {
  function agents(withConfig: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), "agents-"));
    mkdirSync(join(dir, "me", ".taskfast"), { recursive: true });
    writeFileSync(join(dir, "me", "agent.json"), JSON.stringify(example("careful-worker.json")));
    if (withConfig) writeFileSync(join(dir, "me", ".taskfast", "config.json"), "{}");
    mkdirSync(join(dir, "notes")); // no agent.json: not an agent
    return dir;
  }

  it("opens each agent with its own config, then pings and closes it", async () => {
    const dir = agents(true);
    const calls: unknown[] = [];
    const stop = new AbortController();
    const agent: AgentHandle = {
      deliver: async () => {},
      ping: async () => (calls.push(["ping"]), stop.abort()),
      close: async () => void calls.push(["close"]),
    };
    await runAgents({ agentsDir: dir, env: "staging", openAgent: async ({ runtime: rt }) => { calls.push(["open", rt]); return agent; }, listen: () => ({ close: async () => {} }), signal: stop.signal, log: () => {} });
    expect(calls).toEqual([["open", { env: "staging", configPath: join(dir, "me", ".taskfast", "config.json") }], ["ping"], ["close"]]);
  });

  it("keeps every agent's store and unlock path in its own folder", async () => {
    const dir = agents(true);
    mkdirSync(join(dir, "two", ".taskfast"), { recursive: true });
    writeFileSync(join(dir, "two", "agent.json"), JSON.stringify(example("careful-worker.json")));
    writeFileSync(join(dir, "two", ".taskfast", "config.json"), "{}");
    for (const id of ["me", "two"]) writeFileSync(join(dir, id, ".taskfast", "wallet-password"), "simulated user-owned file", { mode: 0o400 });
    const opened: { id: string; storePath: string; file: string | undefined }[] = [];
    const stop = new AbortController();
    await runAgents({ agentsDir: dir, env: "staging", signal: stop.signal, log: () => {}, listen: () => ({ close: async () => {} }), openAgent: async ({ id, storePath, runtime }) => {
      opened.push({ id, storePath, file: runtime.walletPasswordFile });
      return { deliver: async () => {}, ping: async () => { stop.abort(); }, close: async () => {} };
    } });
    expect(opened).toEqual(["me", "two"].map((id) => ({ id, storePath: join(dir, id, ".pi-state", "staging", "state.sqlite"), file: join(dir, id, ".taskfast", "wallet-password") })));
  });

  it.each(["root", "state"])("refuses a linked agent %s before opening any store", async (target) => {
    const root = mkdtempSync(join(tmpdir(), "linked-agent-"));
    const dir = join(root, "agents");
    const real = target === "root" ? join(root, "outside") : join(dir, "me");
    mkdirSync(join(real, ".taskfast"), { recursive: true });
    writeFileSync(join(real, "agent.json"), JSON.stringify(example("careful-worker.json")));
    writeFileSync(join(real, ".taskfast", "config.json"), "{}");
    if (target === "root") { mkdirSync(dir); symlinkSync(real, join(dir, "me")); }
    else { mkdirSync(join(root, "outside")); symlinkSync(join(root, "outside"), join(real, ".pi-state")); }
    let opens = 0;
    await expect(runAgents({ agentsDir: dir, env: "staging", signal: AbortSignal.abort(), log: () => {}, openAgent: async () => {
      opens++;
      return { deliver: async () => {}, ping: async () => {}, close: async () => {} };
    } })).rejects.toThrow(/symlink/);
    expect(opens).toBe(0);
  });

  it("refuses the prior shared store location before opening any agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "prior-agent-store-"));
    const dir = join(root, "agents");
    mkdirSync(join(dir, "me", ".taskfast"), { recursive: true });
    writeFileSync(join(dir, "me", "agent.json"), JSON.stringify(example("careful-worker.json")));
    writeFileSync(join(dir, "me", ".taskfast", "config.json"), "{}");
    const prior = join(root, ".pi-state", "staging", "me", "state.sqlite");
    mkdirSync(join(prior, ".."), { recursive: true });
    writeFileSync(prior, "simulated permanent history");
    let opens = 0;
    await expect(runAgents({ agentsDir: dir, env: "staging", signal: AbortSignal.abort(), log: () => {}, openAgent: async () => {
      opens++;
      return { deliver: async () => {}, ping: async () => {}, close: async () => {} };
    } })).rejects.toThrow(/prior.*store|previous.*store/);
    expect(opens).toBe(0);
    expect(readFileSync(prior, "utf8")).toBe("simulated permanent history");
    expect(() => statSync(join(dir, "me", ".pi-state"))).toThrow();
  });

  it("refuses an agent that has not run taskfast init", async () => {
    const run = runAgents({ agentsDir: agents(false), env: "prod", signal: AbortSignal.abort(), log: () => {} });
    await expect(run).rejects.toThrow(/taskfast --env prod init/);
  });

  it("refuses an empty agents directory", async () => {
    const run = runAgents({ agentsDir: join(tmpdir(), "no-such-agents"), env: "prod", signal: AbortSignal.abort(), log: () => {} });
    await expect(run).rejects.toThrow(/no agents/);
  });
});

// This kit is honest agents only (gh#1538): no adversarial strategy, no test-population
// labels or identities. This file is the only one allowed to name them. agents/ is the
// user's own and is not scanned. The list is kept by hand: there is no list of private
// names to derive it from, so a change that adds a private name adds it here too. An
// ordinary word that matches fails the kit, which is the safe direction.
const FORBIDDEN = /bdaybonus|\b(sniper|sybil|wash|extortion|griefer)\b|intendedAbuse|labels\.jsonl|runGuard|archetype|harness/i;
const SKIP = new Set(["node_modules", "dist", ".git", ".pi-state", ".taskfast", "agents", ".env"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (SKIP.has(n) ? [] : statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
}

it("contains no adversarial or test-population code", () => {
  const hits = files(ROOT)
    .filter((f) => f !== import.meta.filename && !f.endsWith("pnpm-lock.yaml"))
    .filter((f) => FORBIDDEN.test(readFileSync(f, "utf8")))
    .map((f) => relative(ROOT, f));
  expect(hits).toEqual([]);
});
