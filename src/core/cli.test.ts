import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import type { Env } from "./types.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function commandFixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-cli-"));
  directories.push(dir);
  const bin = join(dir, "taskfast");
  writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ok:true,data:{args:process.argv.slice(2),environmentNames:Object.keys(process.env).sort()}}));\n`, { mode: 0o700 });
  vi.stubEnv("TASKFAST_BIN", bin);
  vi.stubEnv("TASKFAST_WALLET_PASSWORD", "not-a-real-password");
  vi.stubEnv("DEEPSEEK_API_KEY", "not-a-real-key");
  const env: Env = "local";
  return { env, configPath: join(dir, "config.json"), walletPasswordFile: join(dir, "wallet with --flags.pw") };
}

it("passes the host unlock file before positionals without adding child environment values", async () => {
  const runtime = commandFixture();
  const result = await runCli(runtime, ["escrow", "sign", "--yes", "--", "00000000-0000-4000-8000-000000000001"]);
  expect(result).toEqual({ outcome: "ok", data: {
    args: ["--env", "local", "escrow", "sign", "--yes", `--wallet-password-file=${runtime.walletPasswordFile}`, "--", "00000000-0000-4000-8000-000000000001"],
    environmentNames: ["HOME", "PATH", "TASKFAST_CONFIG"],
  } });
});

it.each([
  { args: ["post", "--title=Edit the guide"], before: ["post", "--title=Edit the guide"], after: [] },
  { args: ["settle", "--", "00000000-0000-4000-8000-000000000001"], before: ["settle"], after: ["--", "00000000-0000-4000-8000-000000000001"] },
])("supplies the same host-only option for $args", async ({ args, before, after }) => {
  const runtime = commandFixture();
  const result = await runCli(runtime, args);
  expect(result.data).toMatchObject({ args: ["--env", "local", ...before, `--wallet-password-file=${runtime.walletPasswordFile}`, ...after] });
});

it("leaves unsigned reads and unconfigured signing commands unchanged", async () => {
  const runtime = commandFixture();
  expect((await runCli(runtime, ["me"])).data).toMatchObject({ args: ["--env", "local", "me"] });
  expect((await runCli({ ...runtime, walletPasswordFile: undefined }, ["post", "--title=Guide"])).data).toMatchObject({ args: ["--env", "local", "post", "--title=Guide"] });
});

it.each(["relative.pw", "/tmp/invalid\0.pw"])("refuses invalid host file paths before spawning: %j", async (file) => {
  const runtime = { ...commandFixture(), walletPasswordFile: file };
  vi.stubEnv("TASKFAST_BIN", "/missing/taskfast");
  expect(await runCli(runtime, ["post", "--title=Guide"])).toEqual({ outcome: "failed", error: "config: wallet password file must be an absolute path without NUL" });
});
