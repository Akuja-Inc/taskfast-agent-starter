import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
    await runAgents({ agentsDir: dir, stateDir: join(dir, "state"), env: "staging", openAgent: async (_id, _spec, rt) => { calls.push(["open", rt]); return agent; }, listen: () => ({ close: async () => {} }), signal: stop.signal, log: () => {} });
    expect(calls).toEqual([["open", { env: "staging", configPath: join(dir, "me", ".taskfast", "config.json") }], ["ping"], ["close"]]);
  });

  it("refuses an agent that has not run taskfast init", async () => {
    const run = runAgents({ agentsDir: agents(false), stateDir: "unused", env: "prod", signal: AbortSignal.abort(), log: () => {} });
    await expect(run).rejects.toThrow(/taskfast --env prod init/);
  });

  it("refuses an empty agents directory", async () => {
    const run = runAgents({ agentsDir: join(tmpdir(), "no-such-agents"), stateDir: "unused", env: "prod", signal: AbortSignal.abort(), log: () => {} });
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
