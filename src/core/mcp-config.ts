import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import { folderFile } from "./folder.js";

// An agent's MCP servers: `mcp.json` (no secrets) names each server, how to reach it and
// the tools its owner approved, by the fingerprint of the reviewed definition. Credentials
// live in the private `.mcp.env` and are referenced by name, apart from the model's `.env`.
export const MCP_CONFIG = "mcp.json";
export const MCP_SECRETS = ".mcp.env";
const MAX_SERVERS = 8;
const SERVER = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SETTING = /^[A-Z][A-Z0-9_]*$/;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

interface Common { name: string; credentials: Record<string, string>; tools: Record<string, string> }
export type McpServer =
  | (Common & { transport: "stdio"; command: string; args: string[]; cwd: string })
  | (Common & { transport: "http"; url: string });

const bad = (why: string): never => {
  throw new Error(why);
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function fields(value: unknown, where: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) bad(`${where} must be an object`);
  for (const key of Object.keys(value as object)) if (!allowed.includes(key)) bad(`${where} has no field ${key}`);
  return value as Record<string, unknown>;
}
function strings(value: unknown, where: string, key: RegExp, what: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) bad(`${where} must be an object`);
  const out: Record<string, string> = {};
  for (const [name, item] of Object.entries(value as object)) {
    if (!key.test(name)) bad(`${where}.${name}: ${what}`);
    if (typeof item !== "string") bad(`${where}.${name} must be a string`);
    out[name] = item as string;
  }
  return out;
}

function secrets(agentDir: string): Map<string, string> {
  const path = folderFile({ agentDir, path: MCP_SECRETS, resource: MCP_SECRETS });
  if (!existsSync(path)) return new Map();
  if ((lstatSync(path).mode & 0o077) !== 0) bad(`${MCP_SECRETS} must be readable by you only; run chmod 600 on it`);
  return new Map(Object.entries(parseEnv(readFileSync(path, "utf8"))).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
}

// The agent folder's MCP servers. No mcp.json means none; anything malformed throws, so
// the agent fails closed before it opens its store.
export function loadMcpConfig(agentDir: string): McpServer[] {
  const path = folderFile({ agentDir, path: MCP_CONFIG, resource: MCP_CONFIG });
  if (!existsSync(path)) return [];
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch { bad(`${MCP_CONFIG} is not valid JSON`); }
  const root = fields(raw, MCP_CONFIG, ["servers"]);
  if (!isRecord(root.servers)) bad(`${MCP_CONFIG}: servers must be an object`);
  const entries = Object.entries(root.servers as object);
  if (entries.length > MAX_SERVERS) bad(`${MCP_CONFIG} has more than ${MAX_SERVERS} servers`);
  const vault = secrets(agentDir);
  return entries.map(([name, value]): McpServer => {
    const where = `servers.${name}`;
    if (!SERVER.test(name)) bad(`${where}: a server name is 1-32 lowercase letters, digits and dashes`);
    const local = isRecord(value) && "command" in value;
    if (local === (isRecord(value) && "url" in value)) bad(`${where} needs exactly one of command or url`);
    const server = fields(value, where, local ? ["command", "args", "cwd", "env", "tools"] : ["url", "headers", "tools"]);
    const tools = strings(server.tools, `${where}.tools`, /^.{1,128}$/s, "a tool name is 1-128 characters");
    for (const [tool, hash] of Object.entries(tools)) if (!HASH.test(hash)) bad(`${where}.tools.${tool} must be the 64-character sha256 fingerprint the host logs for it`);
    // A local server's credentials are environment variables; a remote server's are headers.
    const kind = local ? "env" : "headers";
    const bindings = local
      ? strings(server.env, `${where}.${kind}`, SETTING, "an environment variable name is uppercase letters, digits and _")
      : strings(server.headers, `${where}.${kind}`, HEADER, "a header name is letters, digits and dashes");
    const credentials: Record<string, string> = {};
    for (const [target, secret] of Object.entries(bindings)) {
      const at = `${where}.${kind}.${target}`;
      if (local && (target === "PATH" || target === "HOME")) bad(`${at}: PATH and HOME are set by the host`);
      if (!SETTING.test(secret)) bad(`${at} must name a setting in ${MCP_SECRETS}, such as DOCS_TOKEN`);
      credentials[target] = vault.get(secret) ?? bad(`${at}: ${secret} is not set in ${MCP_SECRETS}`);
    }
    if (!local) {
      let url: URL;
      try { url = new URL(String(server.url)); }
      catch { return bad(`${where}.url must be a URL`); }
      if (url.username || url.password) bad(`${where}.url must not contain a user name or password`);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) bad(`${where}.url must use https, or http to 127.0.0.1, localhost or [::1]`);
      return { name, transport: "http", url: url.href, credentials, tools };
    }
    const command = server.command;
    if (typeof command !== "string" || !isAbsolute(command) || !statSync(command, { throwIfNoEntry: false })?.isFile()) bad(`${where}.command must be an absolute path to an existing file`);
    const args = server.args ?? [];
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) bad(`${where}.args must be a list of strings`);
    const cwd = folderFile({ agentDir, path: typeof server.cwd === "string" ? server.cwd : ".", resource: `${where}.cwd` });
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) bad(`${where}.cwd must be a folder inside the agent folder`);
    return { name, transport: "stdio", command: command as string, args: args as string[], cwd, credentials, tools };
  });
}

// The fingerprint an owner approves: sha256 of the definition's reviewed fields as JSON
// with sorted keys. Any change to them, server claims included, needs a new approval.
export function toolHash(tool: { name: string; title?: string; description?: string; inputSchema: unknown; outputSchema?: unknown; annotations?: unknown }): string {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
  const { name, title, description, inputSchema, outputSchema, annotations } = tool;
  return createHash("sha256").update(JSON.stringify(sorted({ name, title, description, inputSchema, outputSchema, annotations }))).digest("hex");
}

// Providers accept at most 64 characters of [A-Za-z0-9_-]; a longer name is refused, not cut.
export function mcpToolName(server: string, tool: string): string {
  const name = `mcp_${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
  if (name.length > 64) bad(`tool ${server}/${tool} becomes ${name}, longer than 64 characters`);
  return name;
}

export function redact(text: string, values: readonly string[]): string {
  return values.filter(Boolean).reduce((out, value) => out.split(value).join("[redacted]"), text);
}
