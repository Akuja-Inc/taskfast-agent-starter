import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const HAS_PTY = process.platform !== "win32" && spawnSync("python3", ["-c", "import pty"]).status === 0;

beforeAll(() => {
  if (!HAS_PTY) return;
  const build = spawnSync(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: ROOT, encoding: "utf8" });
  expect(build.stdout + build.stderr).toBe("");
  expect(build.status).toBe(0);
});

function kit(): string {
  const root = mkdtempSync(join(tmpdir(), "setup-terminal-"));
  cpSync(join(ROOT, "examples"), join(root, "examples"), { recursive: true });
  cpSync(join(ROOT, "providers.json"), join(root, "providers.json"));
  writeFileSync(join(root, "package.json"), "{}");
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
  return root;
}

it.skipIf(!HAS_PTY).each(["handoff", "secret", "cancel"])("setup terminal: %s", (scenario) => {
  const root = kit();
  const run = spawnSync("python3", [join(ROOT, "test/setup-terminal.py"), process.execPath, join(ROOT, "dist/src/setup.js"), root, scenario], { encoding: "utf8", timeout: 15_000 });
  expect(run.error).toBeUndefined();
  expect(run.stdout + run.stderr).toBe("");
  expect(run.status).toBe(0);
});

it.skipIf(!HAS_PTY)("keeps buffered pipe answers and reports early EOF", () => {
  const root = kit();
  const args = [join(ROOT, "dist/src/setup.js"), "--env", "staging", "--provider", "anthropic", "--model", "claude-sonnet-4-6", "--agent", "piped", "--role", "worker", "--no-init"];
  const env = { HOME: process.env.HOME, PATH: process.env.PATH };
  const run = spawnSync(process.execPath, args, { cwd: root, env, input: "dummy-key\nDemo\nStudio\nCareful work\nEarn repeat clients\n", encoding: "utf8", timeout: 5_000 });
  expect(run.status).toBe(0);
  expect(run.stdout + run.stderr).not.toContain("dummy-key");
  expect(readFileSync(join(root, "agents", "piped", ".env"), "utf8")).toBe("ANTHROPIC_API_KEY=dummy-key\n");
  const ended = spawnSync(process.execPath, args, { cwd: kit(), env, input: "", encoding: "utf8", timeout: 5_000 });
  expect(ended.status).toBe(1);
  expect(ended.stderr).toContain("input ended before setup finished");
});
