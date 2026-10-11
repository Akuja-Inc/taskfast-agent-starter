import { execFile } from "node:child_process";
import type { Json, Runtime } from "./types.js";

// How a command ended, from the actor's side:
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

// The whole environment of a taskfast child run for this actor: only its own config.
// Nothing from the host process (another persona's key, a custom endpoint) leaks in.
export const cliEnv = (rt: Runtime): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME, TASKFAST_CONFIG: rt.configPath });

// Runs one taskfast command as this actor: its own env (passed as --env, ahead of the
// subcommand), its own persona config and a clean environment.
export function runCli(rt: Runtime, args: string[], timeoutMs = 120_000): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(taskfastBin(), ["--env", rt.env, ...args], { env: cliEnv(rt), timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      let envelope: { ok?: unknown; data?: Json; error?: { code?: unknown; message?: unknown } } | null = null;
      try {
        envelope = JSON.parse(stdout);
      } catch {}
      if (!err && envelope?.ok === true) return resolve({ outcome: "ok", data: envelope.data ?? null });
      const code = typeof envelope?.error?.code === "string" ? envelope.error.code : null;
      const message = typeof envelope?.error?.message === "string" ? envelope.error.message : (err?.message ?? stderr).slice(0, 500) || "taskfast gave no readable result";
      const outcome: Outcome = code && REFUSED.has(code) ? "failed" : "uncertain";
      resolve({ outcome, error: code ? `${code}: ${message}` : message });
    });
  });
}
