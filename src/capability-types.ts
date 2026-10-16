// Browser-safe contracts. Credential values never occur in a view.
export type CapabilityServerConfig =
  | { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> };
export interface CapabilityFile { path: string; text: string }
export interface CapabilitySkill {
  name: string; description: string; enabled: boolean; files: CapabilityFile[];
  provenance?: { source: string; version: string; files: Record<string, string> };
  modifiedFiles?: string[];
}
export interface CapabilityTool {
  name: string; description: string; inputSchema: unknown; outputSchema?: unknown;
  annotations?: unknown; hash: string; blocked: boolean;
}
export interface CapabilityServer {
  name: string; config: CapabilityServerConfig; enabled: boolean;
  approved: { name: string; hash: string }[]; credentials: string[];
}
export interface CapabilityTest {
  testId: string; name: string; tools: CapabilityTool[];
}
export type CapabilityApply =
  | { state: "idle" }
  | { state: "waiting" | "applying" | "succeeded" | "cancelled"; requestId: string }
  | { state: "failed"; requestId: string; error: string };
export interface CapabilityView {
  agentDir: string; revision: string; activeRevision: string | null;
  skills: CapabilitySkill[]; servers: CapabilityServer[]; credentials: string[];
  activeSkills: CapabilitySkill[]; activeServers: CapabilityServer[];
  savedSkills?: CapabilitySkill[]; savedServers?: CapabilityServer[];
  credentialChanges: { name: string; change: "added" | "replaced" | "removed" }[];
  connections?: { name: string; state: "connected" | "disconnected" }[];
  skillPreview?: { previewId: string; skill: CapabilitySkill };
  pending: boolean; apply: CapabilityApply; test?: CapabilityTest;
}
export interface CapabilityActivation {
  publish: () => Promise<void>; rollback: () => Promise<void>; signal: AbortSignal;
  // Register once while activate runs. Scheduling starts only after the journal commits.
  afterCommit(action: () => Promise<void>, onFailure?: (restored: boolean) => Promise<void>): void;
}
export interface CapabilityManagerOptions {
  agentDir: string; env: string;
  activate: (options: CapabilityActivation) => Promise<void>;
  // Set false for stopped agents; otherwise the initial actual configuration is active.
  active?: boolean;
  connections?: () => { name: string; state: "connected" | "disconnected" }[];
}
// Every command body includes revision. Server approval is a list of explicitly reviewed
// reads, never inferred from annotations: approved: [{name, hash, read: true}].
export interface CapabilityApproval { name: string; hash: string; read: true }
