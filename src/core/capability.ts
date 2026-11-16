import { defineExtension, section, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";

// One connected add-on beyond the marketplace tools: skills or MCP. `name` names both the
// extension and its prompt section, so a capability carries its whole surface with it.
export interface Capability {
  name: string;
  tools: ToolRegistration[];
  // The prompt section naming the tools; empty when there are none.
  prompt: string;
  status(): { name: string; state: "connected" | "disconnected" }[];
  close(): Promise<void>;
}

// A capability without tools installs nothing: no extension, no prompt section.
export function installCapability(registry: Registry, cap: Capability): void {
  if (!cap.tools.length) return;
  registry.install(defineExtension({ name: cap.name, tools: cap.tools, sections: [section(cap.name, () => cap.prompt, { tag: false })] }));
}
