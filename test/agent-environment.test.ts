import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../src/core/types.js";
import { runAgents } from "../src/run.js";
import { copyExample } from "./example.js";

const ROOT = join(import.meta.dirname, "..");
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), "agent-environment-"));
  dirs.push(dir);
  return dir;
}

function folder(root: string, id: string, config: unknown) {
  const dir = join(root, id);
  mkdirSync(join(dir, ".taskfast"), { recursive: true });
  copyExample("careful-worker", dir);
  writeFileSync(join(dir, ".taskfast/config.json"), JSON.stringify(config));
  return dir;
}

it.each<Env>(["staging", "local", "prod"])("opens only %s agents and leaves excluded folders untouched", async (env) => {
  const dir = temporary();
  for (const other of ["prod", "staging", "local"]) {
    const home = folder(dir, other, { environment: other });
    if (other !== env) {
      // Selection must precede spec/provider validation and capability recovery.
      writeFileSync(join(home, "agent.json"), "not JSON");
      writeFileSync(join(home, ".env"), "GOOGLE_APPLICATION_CREDENTIALS=/not-portable\n");
    }
  }
  const stop = new AbortController();
  const logs: string[] = [];
  const open = vi.fn(async () => ({
    closed: Promise.resolve({ reason: "closed" as const }), deliver: async () => {},
    ping: async () => { stop.abort(); }, close: async () => {},
  }));
  const listen = vi.fn(() => ({ close: async () => {} }));
  await runAgents({ agentsDir: dir, env, signal: stop.signal, log: (line) => logs.push(line), openAgent: open, listen });
  expect(open).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: env, runtime: expect.objectContaining({ env }), storePath: join(dir, env, ".pi-state", env, "state.sqlite") }));
  expect(listen).toHaveBeenCalledOnce();
  for (const other of ["prod", "staging", "local"].filter((value) => value !== env)) {
    expect(logs).toContain(`${other}: skipped: configured for ${other}, selected ${env}`);
    expect(existsSync(join(dir, other, ".pi-state"))).toBe(false);
    expect(readFileSync(join(dir, other, "agent.json"), "utf8")).toBe("not JSON");
  }
});

it.each([{}, { environment: null }, { environment: "" }, { environment: "development" }, { environment: 7 }, { environment: ["staging", "prod"] }, { environment: "synthetic-secret" }])("fails closed for an unassociated config %j", async (config) => {
  const dir = temporary();
  folder(dir, "me", config);
  const open = vi.fn();
  const logs: string[] = [];
  await expect(runAgents({ agentsDir: dir, env: "prod", signal: new AbortController().signal, log: (line) => logs.push(line), openAgent: open })).rejects.toThrow("no agents match prod");
  expect(open).not.toHaveBeenCalled();
  expect(logs.join("\n")).toContain("environment");
  expect(logs.join("\n")).not.toContain("synthetic-secret");
  expect(existsSync(join(dir, "me", ".pi-state"))).toBe(false);
});

it("accepts the CLI's production alias without treating absent environments as production", async () => {
  const dir = temporary();
  folder(dir, "alias", { environment: "production" });
  folder(dir, "unknown", {});
  const stop = new AbortController();
  const opened: string[] = [];
  await runAgents({ agentsDir: dir, env: "prod", signal: stop.signal, log: () => {}, listen: () => ({ close: async () => {} }), openAgent: async ({ id }) => {
    opened.push(id);
    return { closed: Promise.resolve({ reason: "closed" }), deliver: async () => {}, close: async () => {}, ping: async () => { stop.abort(); } };
  } });
  expect(opened).toEqual(["alias"]);
});

it.each([{ args: [] }, { args: ["--console"] }])("exits with no matches before binding a console: %j", async ({ args }) => {
  const dir = temporary();
  const home = folder(join(dir, "agents"), "staging-only", { environment: "staging" });
  // Old code must also fail locally instead of reaching any model or marketplace.
  writeFileSync(join(home, "agent.json"), "not JSON");
  const result = spawnSync(process.execPath, [join(ROOT, "dist/src/run.js"), ...args], {
    cwd: dir, env: { PATH: "", HOME: dir }, encoding: "utf8", timeout: 2_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("no agents match prod");
  expect(result.stdout).toContain("configured for staging, selected prod");
  expect(result.stdout).not.toContain("console:");
});

it("explains environment selection in command help without opening agents", () => {
  const dir = temporary();
  const result = spawnSync(process.execPath, [join(ROOT, "dist/src/run.js"), "--help"], {
    cwd: dir, env: { PATH: "", HOME: dir }, encoding: "utf8", timeout: 5_000,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("only agents");
  expect(result.stdout).toContain("production (default)");
  expect(result.stdout).toContain("staging");
  expect(result.stdout).toContain("development");
});
