// The Durable Object's marketplace path (#144 option A): one `taskfast` process per
// command in a stateless Container that only this DO can reach. The Container
// returns the CLI's stdout unchanged, so `cliOutcome` and REFUSED keep their meaning.
import { cliOutcome, signs, type CliResult } from "../../src/core/cli.js";
import type { Command } from "../../src/core/policy.js";

// The command paths the kit sends: every tool's (src/core/tools.ts), plus the reads
// and cleanup policy and money.ts run themselves. Anything else is refused here.
export const COMMANDS = new Set([
  // Tool reads.
  "me", "wallet balance", "discover", "task get", "task list", "task bids", "bid list",
  "message list", "message conversations", "platform config", "agent list", "agent get",
  "dispute", "artifact list", "artifact get", "payment get", "payment list", "review list",
  // Tool writes and money.
  "bid create", "bid cancel", "bid accept", "bid reject", "task claim", "task refuse", "task abort",
  "task concede", "task submit", "task remedy", "task approve", "task dispute", "task retry-fee",
  "task reassign", "task open", "task edit", "task cancel", "task reopen", "message send",
  "review create", "post", "settle", "escrow sign", "bond post", "stake",
  // Policy's own: upload cleanup before a submit, and the bond token's decimals.
  "artifact delete", "cast call",
]);
export const commandPath = (args: string[]): string => {
  const words: string[] = [];
  for (const arg of args) { if (arg.startsWith("-")) break; words.push(arg); }
  return words.join(" ");
};

// What the DO posts to the Container: the argv after `taskfast`, the agent's TaskFast
// config text, and the wallet only for a command that signs. The Container writes
// them to a per-call folder and deletes it.
export interface ContainerCall { args: string[]; config: string; keystore?: string; password?: string }
export interface ContainerReply { stdout: string; stderr: string; failure?: string }
export interface Wallet { keystore: string; password: string }

export function containerCommand(o: { ready(): Promise<boolean>; call(body: ContainerCall): Promise<Response>; config: string; wallet?: Wallet }): Command {
  return async (runtime, args): Promise<CliResult> => {
    if (!COMMANDS.has(commandPath(args))) return { outcome: "failed", error: `unsupported: the kit does not send "${commandPath(args)}"` };
    const signing = signs(args);
    if (signing && !o.wallet) return { outcome: "failed", error: "keystore: the WALLET_KEYSTORE and WALLET_PASSWORD secrets are not set" };
    // A cold or failing Container is found before the command leaves the DO, so it
    // stays a known refusal. The library retries only this readiness, never a request.
    let ready = false;
    try { ready = await o.ready(); } catch { ready = false; }
    if (!ready) return { outcome: "failed", error: "unavailable: the CLI Container did not start" };
    let response: Response;
    // Anything after the request leaves the DO may have reached the server.
    try { response = await o.call({ args: ["--env", runtime.env, ...args], config: o.config, ...(signing ? o.wallet : {}) }); }
    catch (error) { return { outcome: "uncertain", error: `container unreachable: ${error instanceof Error ? error.message : String(error)}` }; }
    if (!response.ok) return { outcome: "uncertain", error: `container answered ${response.status}` };
    let reply: ContainerReply;
    try { reply = await response.json() as ContainerReply; }
    catch { return { outcome: "uncertain", error: "container gave no readable reply" }; }
    return cliOutcome(String(reply.stdout ?? ""), reply.failure, String(reply.stderr ?? ""));
  };
}
