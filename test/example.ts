import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";

// An example folder as the host reads it: agent.json's fields plus INSTRUCTIONS.md as instructions.
export function example(name: string): Record<string, unknown> {
  const folder = join(import.meta.dirname, "..", "examples", name);
  return { ...JSON.parse(readFileSync(join(folder, "agent.json"), "utf8")), instructions: readFileSync(join(folder, "INSTRUCTIONS.md"), "utf8") };
}

// Copies an example's agent.json and INSTRUCTIONS.md into an agent folder.
export function copyExample(name: string, agentDir: string): void {
  cpSync(join(import.meta.dirname, "..", "examples", name), agentDir, { recursive: true });
}
