// The Durable Object's marketplace path (#144 option A): one `taskfast` process per
// command in a stateless Container that only this DO can reach. The Container
// returns the CLI's stdout unchanged, so `cliOutcome` and REFUSED keep their meaning.
import { cliOutcome, type CliResult } from "../../src/core/cli.js";
import type { Command } from "../../src/core/policy.js";

// The command paths of the read tools in src/core/tools.ts. Writes go through the
// Container from #144 PR4; until then they are refused here before anything is sent.
export const READ_COMMANDS = new Set([
  "me", "wallet balance", "discover", "task get", "task list", "task bids", "bid list",
  "message list", "message conversations", "platform config", "agent list", "agent get",
  "dispute", "artifact list", "artifact get", "payment get", "payment list", "review list",
]);
export const commandPath = (args: string[]): string => {
  const words: string[] = [];
  for (const arg of args) { if (arg.startsWith("-")) break; words.push(arg); }
  return words.join(" ");
};

// What the DO posts to the Container: the argv after `taskfast`, and the agent's
// TaskFast config text, which the Container writes to a per-call file and deletes.
export interface ContainerCall { args: string[]; config: string }
export interface ContainerReply { stdout: string; stderr: string; failure?: string }

export function containerCommand(o: { call(body: ContainerCall): Promise<Response>; config: string }): Command {
  return async (runtime, args): Promise<CliResult> => {
    if (!READ_COMMANDS.has(commandPath(args))) return { outcome: "failed", error: "unavailable: marketplace writes are not deployed yet" };
    let response: Response;
    // Anything after the request leaves the DO may have reached the server.
    try { response = await o.call({ args: ["--env", runtime.env, ...args], config: o.config }); }
    catch (error) { return { outcome: "uncertain", error: `container unreachable: ${error instanceof Error ? error.message : String(error)}` }; }
    if (!response.ok) return { outcome: "uncertain", error: `container answered ${response.status}` };
    let reply: ContainerReply;
    try { reply = await response.json() as ContainerReply; }
    catch { return { outcome: "uncertain", error: "container gave no readable reply" }; }
    return cliOutcome(String(reply.stdout ?? ""), reply.failure, String(reply.stderr ?? ""));
  };
}
