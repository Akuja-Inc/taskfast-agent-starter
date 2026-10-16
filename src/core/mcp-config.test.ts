import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadMcpConfig, MCP_CONFIG, MCP_SECRETS, mcpToolName, redact, toolHash } from "./mcp-config.js";

const HASH = "a".repeat(64);
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
function folder(config?: unknown, secrets?: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-config-"));
  dirs.push(dir);
  if (config !== undefined) writeFileSync(join(dir, MCP_CONFIG), typeof config === "string" ? config : JSON.stringify(config));
  if (secrets !== undefined) { writeFileSync(join(dir, MCP_SECRETS), secrets); chmodSync(join(dir, MCP_SECRETS), mode); }
  return dir;
}
const local = { command: process.execPath, args: ["server.mjs"], tools: { search: HASH } };

it("has no servers without mcp.json", () => {
  expect(loadMcpConfig(folder())).toEqual([]);
});

it("reads a local and a remote server, binding credentials by name from the private file", () => {
  const dir = folder({ servers: {
    docs: { ...local, cwd: "mcp", env: { DOCS_TOKEN: "DOCS_SECRET" } },
    web: { url: "https://mcp.example.com/mcp", headers: { Authorization: "WEB_AUTH" }, tools: {} },
  } }, "DOCS_SECRET=docs-value\nWEB_AUTH=Bearer web-value\nUNUSED=x\n");
  mkdirSync(join(dir, "mcp"));
  expect(loadMcpConfig(dir)).toEqual([
    { name: "docs", transport: "stdio", command: process.execPath, args: ["server.mjs"], cwd: join(dir, "mcp"), credentials: { DOCS_TOKEN: "docs-value" }, tools: { search: HASH } },
    { name: "web", transport: "http", url: "https://mcp.example.com/mcp", credentials: { Authorization: "Bearer web-value" }, tools: {} },
  ]);
});

it("keeps disabled servers out of the runtime even without their credentials", () => {
  expect(loadMcpConfig(folder({ servers: { offline: { url: "https://offline.example/mcp", headers: { Authorization: "MISSING" }, tools: {}, enabled: false } } }))).toEqual([]);
  expect(() => loadMcpConfig(folder({ servers: { offline: { url: "https://offline.example/mcp", enabled: "false" } } }))).toThrow(/enabled must be boolean/);
  expect(() => loadMcpConfig(folder({ servers: { offline: { url: "http://unsafe.example/mcp", enabled: false } } }))).toThrow(/must use https/);
});
it.each(["https://example.com/mcp?token=private", "https://example.com/mcp#private"])("refuses credential-bearing URL components: %s", (url) => {
  expect(() => loadMcpConfig(folder({ servers: { remote: { url, tools: {} } } }))).toThrow(/query or fragment/);
});
it("allows plain http only to this machine", () => {
  for (const url of ["http://127.0.0.1:9000/mcp", "http://localhost/mcp", "http://[::1]:9000/mcp"]) {
    expect(loadMcpConfig(folder({ servers: { web: { url, tools: {} } } }))[0]).toMatchObject({ url });
  }
});

const malformed: { name: string; config: unknown; secrets?: string; mode?: number; error: RegExp }[] = [
  { name: "invalid JSON", config: "{", error: /mcp\.json is not valid JSON/ },
  { name: "an unknown top-level field", config: { servers: {}, extra: 1 }, error: /mcp\.json has no field extra/ },
  { name: "a bad server name", config: { servers: { "Bad Name": local } }, error: /servers\.Bad Name: a server name is 1-32 lowercase letters, digits and dashes/ },
  { name: "too many servers", config: { servers: Object.fromEntries(Array.from({ length: 9 }, (_, n) => [`s${n}`, local])) }, error: /more than 8 servers/ },
  { name: "both command and url", config: { servers: { docs: { ...local, url: "https://x.example/mcp" } } }, error: /servers\.docs needs exactly one of command or url/ },
  { name: "neither command nor url", config: { servers: { docs: { tools: {} } } }, error: /servers\.docs needs exactly one of command or url/ },
  { name: "a relative command", config: { servers: { docs: { ...local, command: "node" } } }, error: /servers\.docs\.command must be an absolute path to an existing file/ },
  { name: "a missing command", config: { servers: { docs: { ...local, command: "/no/such/server" } } }, error: /servers\.docs\.command must be an absolute path to an existing file/ },
  { name: "non-string arguments", config: { servers: { docs: { ...local, args: [1] } } }, error: /servers\.docs\.args must be a list of strings/ },
  { name: "a cwd outside the folder", config: { servers: { docs: { ...local, cwd: "../elsewhere" } } }, error: /servers\.docs\.cwd must refer to a file inside the agent folder/ },
  { name: "a missing cwd", config: { servers: { docs: { ...local, cwd: "nowhere" } } }, error: /servers\.docs\.cwd must be a folder inside the agent folder/ },
  { name: "a remote server over plain http", config: { servers: { web: { url: "http://mcp.example.com/mcp", tools: {} } } }, error: /servers\.web\.url must use https, or http to 127\.0\.0\.1, localhost or \[::1\]/ },
  { name: "credentials in the url", config: { servers: { web: { url: "https://user:pass@mcp.example.com/mcp", tools: {} } } }, error: /servers\.web\.url must not contain a user name or password/ },
  { name: "headers on a local server", config: { servers: { docs: { ...local, headers: {} } } }, error: /servers\.docs has no field headers/ },
  { name: "env on a remote server", config: { servers: { web: { url: "https://x.example/mcp", env: {}, tools: {} } } }, error: /servers\.web has no field env/ },
  { name: "a bad tool fingerprint", config: { servers: { docs: { ...local, tools: { search: "abc" } } } }, error: /servers\.docs\.tools\.search must be the 64-character sha256 fingerprint the host logs/ },
  { name: "a credential name that is not a setting name", config: { servers: { docs: { ...local, env: { TOKEN: "lower" } } } }, error: /servers\.docs\.env\.TOKEN must name a setting in \.mcp\.env/ },
  { name: "a missing credentials file", config: { servers: { docs: { ...local, env: { TOKEN: "DOCS_SECRET" } } } }, error: /servers\.docs\.env\.TOKEN: DOCS_SECRET is not set in \.mcp\.env/ },
  { name: "a missing credential", config: { servers: { docs: { ...local, env: { TOKEN: "DOCS_SECRET" } } } }, secrets: "OTHER=x\n", error: /DOCS_SECRET is not set in \.mcp\.env/ },
  { name: "an empty credential", config: { servers: { docs: { ...local, env: { TOKEN: "DOCS_SECRET" } } } }, secrets: "DOCS_SECRET=\n", error: /DOCS_SECRET is not set in \.mcp\.env/ },
  { name: "a credentials file others can read", config: { servers: {} }, secrets: "A=b\n", mode: 0o644, error: /\.mcp\.env must be readable by you only; run chmod 600/ },
  { name: "a variable the host owns", config: { servers: { docs: { ...local, env: { PATH: "DOCS_SECRET" } } } }, secrets: "DOCS_SECRET=x\n", error: /servers\.docs\.env\.PATH: PATH and HOME are set by the host/ },
];
it.each(malformed)("refuses $name, failing the agent closed", ({ config, secrets, mode, error }) => {
  expect(() => loadMcpConfig(folder(config, secrets, mode))).toThrow(error);
});

it("refuses a linked config or credentials file", () => {
  const dir = folder();
  writeFileSync(join(dir, "real.json"), JSON.stringify({ servers: {} }));
  symlinkSync(join(dir, "real.json"), join(dir, MCP_CONFIG));
  expect(() => loadMcpConfig(dir)).toThrow(/must not use a symlink inside the agent folder/);
});

it("fingerprints a tool's definition, not the order of its keys", () => {
  const tool = { name: "search", description: "Search.", inputSchema: { type: "object", properties: { q: { type: "string" } } } };
  const reordered = { inputSchema: { properties: { q: { type: "string" } }, type: "object" }, description: "Search.", name: "search", _meta: { ignored: true } };
  expect(toolHash(tool)).toMatch(/^[0-9a-f]{64}$/);
  expect(toolHash(reordered)).toBe(toolHash(tool));
  expect(toolHash({ ...tool, description: "Search more." })).not.toBe(toolHash(tool));
  expect(toolHash({ ...tool, annotations: { readOnlyHint: true } })).not.toBe(toolHash(tool));
});

it("names a server's tool for the model, refusing names a provider would reject", () => {
  expect(mcpToolName("docs", "search")).toBe("mcp_docs_search");
  expect(mcpToolName("my-docs", "find.page v2")).toBe("mcp_my-docs_find_page_v2");
  expect(() => mcpToolName("docs", "x".repeat(60))).toThrow(/longer than 64 characters/);
});

it("redacts every credential value", () => {
  expect(redact("token abc123 then Bearer xyz and abc123", ["abc123", "Bearer xyz"])).toBe("token [redacted] then [redacted] and [redacted]");
  expect(redact("nothing secret", [])).toBe("nothing secret");
  expect(redact(JSON.stringify({ error: 'token sec"ret' }), ['sec"ret'])).toBe('{"error":"token [redacted]"}');
  expect(redact("abc123", ["abc", "abc123"])).toBe("[redacted]");
});
