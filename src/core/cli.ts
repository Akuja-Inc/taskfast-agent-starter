import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Json, Runtime } from "./types.js";
import { agentDirectory } from "./folder.js";

// How a command ended, from the agent's side:
// - ok: the CLI reported success.
// - failed: the CLI or server refused it before acting (bad input, auth, rate limit,
//   validation, wallet). Nothing changed on the server.
// - uncertain: the request may have reached the server (network or server error,
//   timeout, crash, unreadable output). Never repeated blindly.
export type Outcome = "ok" | "failed" | "uncertain";
export interface CliResult {
  outcome: Outcome;
  data?: Json;
  error?: string;
}

// CLI error codes that mean the request was refused before it did anything.
const REFUSED = new Set(["usage", "auth", "missing_api_key", "rate_limited", "validation", "keystore", "signing", "config", "unimplemented", "custom_api_base"]);

export const taskfastBin = (): string => process.env.TASKFAST_BIN ?? "taskfast";

// The whole environment of a taskfast child: only its own config.
// No model credential, wallet password or custom endpoint leaks from the host.
export const cliEnv = (rt: Runtime): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME, TASKFAST_CONFIG: rt.configPath });

export function parseWalletPasswordFile(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) throw new Error("wallet password file must be an absolute path without NUL");
  return value;
}

// The commands that decrypt the wallet, and so the only ones that get its unlock.
export const signs = (args: string[]): boolean =>
  args[0] === "post" || args[0] === "settle" || (args[0] === "escrow" && args[1] === "sign") || (args[0] === "bond" && args[1] === "post");

// Runs one command with the agent's env before the subcommand, its own TaskFast
// config, and a clean environment. Only signing commands receive the host's file
// path, as one option before the positional delimiter; no password is inherited.
export function runCli(rt: Runtime, args: string[], timeoutMs = 120_000): Promise<CliResult> {
  let commandArgs = args;
  if (rt.walletPasswordFile !== undefined) {
    let file: string;
    try { file = parseWalletPasswordFile(rt.walletPasswordFile); }
    catch { return Promise.resolve({ outcome: "failed", error: "config: wallet password file must be an absolute path without NUL" }); }
    if (signs(args)) {
      const delimiter = args.indexOf("--");
      const at = delimiter < 0 ? args.length : delimiter;
      commandArgs = [...args.slice(0, at), `--wallet-password-file=${file}`, ...args.slice(at)];
    }
  }
  return new Promise((resolve) => {
    execFile(taskfastBin(), ["--env", rt.env, ...commandArgs], { env: cliEnv(rt), cwd: agentDirectory(rt), timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      resolve(cliOutcome(stdout, err ? err.message : undefined, stderr));
    });
  });
}

// One finished command's stdout as an outcome. `failure` is set when the process
// did not exit 0 (or never ran); only a known refusal code becomes `failed`.
export function cliOutcome(stdout: string, failure: string | undefined, stderr = ""): CliResult {
  let envelope: { ok?: unknown; data?: Json; error?: { code?: unknown; message?: unknown } } | null = null;
  try {
    envelope = JSON.parse(stdout);
  } catch {}
  if (failure === undefined && envelope?.ok === true) return { outcome: "ok", data: envelope.data ?? null };
  const code = typeof envelope?.error?.code === "string" ? envelope.error.code : null;
  const message = typeof envelope?.error?.message === "string" ? envelope.error.message : (failure ?? stderr).slice(0, 500) || "taskfast gave no readable result";
  const outcome: Outcome = code && REFUSED.has(code) ? "failed" : "uncertain";
  return { outcome, error: code ? `${code}: ${message}` : message };
}
