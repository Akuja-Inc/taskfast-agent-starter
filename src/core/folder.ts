import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { Runtime } from "./types.js";

export const WALLET_PATH = ".taskfast/wallet.json";
export const PASSWORD_PATH = ".taskfast/wallet-password";
export const CREDENTIAL_FILES = ["GOOGLE_APPLICATION_CREDENTIALS", "ANTHROPIC_IDENTITY_TOKEN_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE"];

// TASKFAST_CONFIG locates the config, but the CLI resolves wallet paths from cwd.
export function agentDirectory(runtime: Pick<Runtime, "configPath">): string {
  const configDir = dirname(runtime.configPath);
  return basename(configDir) === ".taskfast" ? dirname(configDir) : configDir;
}

export function folderFile(o: { agentDir: string; path: string; resource: string }): string {
  // Normalization must not erase a linked component before we check it.
  if ([o.agentDir, o.path].some((path) => path.split(/[\\/]/).includes(".."))) throw new Error(`${o.resource} must refer to a file inside the agent folder without parent traversal`);
  const root = resolve(o.agentDir);
  if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${o.resource} must not use a symlink agent folder`);
  const path = resolve(root, o.path.startsWith("~/") ? o.path.slice(2) : o.path);
  const local = relative(root, path);
  if (isAbsolute(local) || local === ".." || local.startsWith("../")) throw new Error(`${o.resource} must refer to a file inside the agent folder`);
  let component = root;
  for (const part of local.split("/")) {
    component = resolve(component, part);
    if (lstatSync(component, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${o.resource} must not use a symlink inside the agent folder`);
  }
  return path;
}

export function portableFile(o: { agentDir: string; path: unknown; resource: string }): string {
  if (typeof o.path !== "string" || !o.path.trim() || o.path.includes("\0") || isAbsolute(o.path) || o.path.startsWith("~/")) throw new Error(`${o.resource} must use a nonempty folder-relative path`);
  return folderFile({ ...o, path: o.path });
}

export function credentialSetting(o: { agentDir: string; name: string; value: string }): string {
  if (!CREDENTIAL_FILES.includes(o.name)) return o.value;
  return relative(resolve(o.agentDir), folderFile({ agentDir: o.agentDir, path: o.value, resource: o.name }));
}

export function providerSettings(agentDir: string): Record<string, string> {
  const path = folderFile({ agentDir, path: ".env", resource: "provider settings" });
  const settings: Record<string, string> = {};
  if (existsSync(path)) for (const [name, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (typeof value === "string") {
      if (CREDENTIAL_FILES.includes(name)) portableFile({ agentDir, path: value, resource: name });
      settings[name] = value;
    }
  }
  return settings;
}
