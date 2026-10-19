import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { afterEach, expect, it, vi } from "vitest";
import { approve, expectGone, FIXTURE, httpFixture, writeMcp } from "../../test/mcp-fixture.js";
import { PNG } from "../../test/fixtures/mcp/server.mjs";
import { connectMcp, discoverMcp, type McpTools } from "./mcp.js";
import { loadMcpConfig } from "./mcp-config.js";

const dirs: string[] = [];
const open: McpTools[] = [];
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((mcp) => mcp.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-"));
  dirs.push(dir);
  return dir;
}
const local = (tools: Record<string, string>, extra: Record<string, unknown> = {}) => ({ command: process.execPath, args: [FIXTURE], tools, ...extra });
async function connect(dir: string, logs: string[] = [], reserved = ["me", "skill_read"]): Promise<McpTools> {
  const mcp = await connectMcp(loadMcpConfig(dir), { log: (line) => logs.push(line), reserved });
  open.push(mcp);
  return mcp;
}
// Calls a registered tool the way Pi does, on the root conversation.
async function call(mcp: McpTools, name: string, args: Record<string, unknown>, signal = new AbortController().signal) {
  const tool = mcp.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.execute(args as never, { conversationId: ROOT_CONVERSATION_ID } as never, { abortSignal: signal } as never);
}
const text = (result: Awaited<ReturnType<typeof call>>) => (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

it("discovers bounded review metadata without calling any tool and closes its process tree", async () => {
  const dir = agentDir(); const pidfile = join(dir, "discovery.pid");
  writeMcp(dir, { docs: local({}, { env: { FIXTURE_PIDFILE: "PIDFILE" } }) }, { PIDFILE: pidfile });
  const metadata = await discoverMcp(loadMcpConfig(dir)[0]!);
  expect(metadata.find((tool) => tool.name === "search")).toMatchObject({ hash: approve("search"), blocked: false, description: "Search the docs." });
  expect(metadata.find((tool) => tool.name === "delete")?.blocked).toBe(true);
  await expectGone(Number(readFileSync(pidfile, "utf8")));
});
it("rejects credential-bearing discovered definitions including JSON-escaped values", async () => {
  const { createServer } = await import("node:http");
  const token = 'sec"ret'; const methods: string[] = [];
  const http = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")); methods.push(message.method);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : { tools: [{ name: "search", description: `leaked ${token}`, inputSchema: { type: "object" } }] };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  servers.push({ close: () => new Promise((resolve) => { http.closeAllConnections(); http.close(() => resolve()); }) });
  const error = await discoverMcp({ name: "docs", transport: "http", url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`, credentials: { Authorization: token }, tools: {} }).catch((error: unknown) => error);
  expect(String(error)).toContain("credential"); expect(String(error)).not.toContain(token); expect(methods).not.toContain("tools/call");
});
it("bounds a stalled review handshake and closes its HTTP connection", async () => {
  const { createServer } = await import("node:http");
  const http = createServer(() => {});
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  servers.push({ close: () => new Promise((resolve) => { http.closeAllConnections(); http.close(() => resolve()); }) });
  const dir = agentDir();
  writeMcp(dir, { docs: { url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`, tools: {} } });
  await expect(discoverMcp(loadMcpConfig(dir)[0]!, { connectTimeoutMs: 40 })).rejects.toThrow(/timed out/);
});
it("has no tools and starts nothing without servers", async () => {
  const mcp = await connect(agentDir());
  expect(mcp.tools).toEqual([]);
  expect(mcp.prompt).toBe(""); expect(mcp.status()).toEqual([]);
});

it("exposes only approved tools over stdio, logs the others with their fingerprints and calls the server", async () => {
  const dir = agentDir();
  writeMcp(dir, { docs: local({ search: approve("search") }) });
  const logs: string[] = [];
  const mcp = await connect(dir, logs);
  expect(mcp.tools.map((tool) => tool.name)).toEqual(["mcp_docs_search"]);
  expect(mcp.status()).toEqual([{ name: "docs", state: "connected" }]);
  expect(mcp.tools[0]).toMatchObject({ replay: "unsafe", executionMode: "sequential" });
  expect(mcp.tools[0]!.description).toBe("From MCP server docs, approved by your operator as a read: Search the docs.");
  expect(logs).toContain("mcp docs: tools mcp_docs_search");
  expect(logs).toContain(`mcp docs: tool env is not approved; to approve it, add "env": "${approve("env")}" to servers.docs.tools in mcp.json`);
  expect(mcp.prompt).toContain("mcp_docs_search");
  expect(await call(mcp, "mcp_docs_search", { query: "bonds" })).toEqual({ output: [{ type: "text", text: "results for bonds" }], isError: false });
});

it("saves a tool result's images in the agent folder before the model reads their handles", async () => {
  const dir = agentDir();
  writeMcp(dir, { docs: local({ image: approve("image") }) });
  const mcp = await connectMcp(loadMcpConfig(dir), { log: () => {}, reserved: [], agentDir: dir });
  open.push(mcp);
  const png = Buffer.from(PNG, "base64");
  const handle = `${createHash("sha256").update(png).digest("hex").slice(0, 16)}.png`;
  const line = `[image/png saved as media:${handle}, ${png.length} bytes]`;
  expect(text(await call(mcp, "mcp_docs_image", {}))).toBe(`Rendered:\n${line}\n${line}`);
  expect(readFileSync(join(dir, ".pi-state/media", handle)).equals(png)).toBe(true);
  expect(mcp.prompt).toContain("artifact { name, media }");
  // Without an agent folder the images stay omitted, as before.
  const bare = await connect(dir);
  expect(text(await call(bare, "mcp_docs_image", {}))).toBe("Rendered:\n[image/png image omitted]\n[image/png image omitted]");
  expect(bare.prompt).not.toContain("media");
});

// The server's upload limit decides an image's size, not Pi-mcp's 16 MiB message default.
it("carries an image whose message is larger than Pi-mcp's default limit over stdio", async () => {
  const dir = agentDir();
  writeMcp(dir, { docs: local({ image: approve("image") }) });
  const mcp = await connectMcp(loadMcpConfig(dir), { log: () => {}, reserved: [], agentDir: dir });
  open.push(mcp);
  const bytes = 13 * 1024 * 1024; // about 17.4 MiB as base64
  expect(text(await call(mcp, "mcp_docs_image", { bytes }))).toMatch(new RegExp(`^\\[image/png saved as media:[0-9a-f]{16}\\.png, ${bytes} bytes\\]$`));
}, 20_000);

it.each(["stdio", "http"])("captures a video larger than Pi's default message limit over %s", async (transport) => {
  const dir = agentDir();
  if (transport === "stdio") writeMcp(dir, { docs: local({ video: approve("video") }) });
  else {
    const http = await httpFixture();
    servers.push(http);
    writeMcp(dir, { docs: { url: http.url, tools: { video: approve("video") } } });
  }
  const mcp = await connectMcp(loadMcpConfig(dir), { log: () => {}, reserved: [], agentDir: dir });
  open.push(mcp);
  const bytes = 13 * 1024 * 1024;
  const output = text(await call(mcp, "mcp_docs_video", { bytes }));
  const handle = /saved as media:([0-9a-f]{16}\.mp4),/.exec(output)?.[1];
  expect(handle).toBeDefined();
  const file = readFileSync(join(dir, ".pi-state/media", handle!));
  expect(file.length).toBe(bytes);
  expect(output).toBe(`[video/mp4 saved as media:${createHash("sha256").update(file).digest("hex").slice(0, 16)}.mp4, ${bytes} bytes]`);
  expect(mcp.tools[0]).toMatchObject({ replay: "unsafe", executionMode: "sequential" });
}, 20_000);

it("follows paged tool lists", async () => {
  const dir = agentDir();
  writeMcp(dir, { docs: local({ big: approve("big") }, { env: { FIXTURE_MODE: "MODE" } }) }, { MODE: "paged" });
  expect((await connect(dir)).tools.map((tool) => tool.name)).toEqual(["mcp_docs_big"]);
});

it("gives a local server only PATH, HOME and its own credentials, and never echoes a credential back", async () => {
  const dir = agentDir();
  writeMcp(dir, { docs: local({ env: approve("env") }, { env: { DOCS_TOKEN: "DOCS_SECRET" } }) }, { DOCS_SECRET: "s3cret-value" });
  process.env.TASKFAST_TEST_LEAK = "host-only";
  try {
    const mcp = await connect(dir);
    const output = text(await call(mcp, "mcp_docs_env", {}));
    expect(output).not.toContain("s3cret-value");
    expect(JSON.parse(output)).toEqual({ PATH: process.env.PATH, HOME: process.env.HOME, DOCS_TOKEN: "[redacted]" });
  } finally {
    delete process.env.TASKFAST_TEST_LEAK;
  }
});

it("reaches a remote server over Streamable HTTP with its header credential", async () => {
  const http = await httpFixture();
  servers.push(http);
  const dir = agentDir();
  writeMcp(dir, { web: { url: http.url, headers: { Authorization: "WEB_AUTH" }, tools: { search: approve("search") } } }, { WEB_AUTH: "Bearer web-token" });
  const mcp = await connect(dir);
  expect(await call(mcp, "mcp_web_search", { query: "escrow" })).toEqual({ output: [{ type: "text", text: "results for escrow" }], isError: false });
  expect(http.headers.length).toBeGreaterThan(0);
  expect(http.headers.every((headers) => headers.authorization === "Bearer web-token")).toBe(true);});

it("refuses a redirect instead of following it with credentials", async () => {
  const { createServer } = await import("node:http");
  const redirect = createServer((_request, response) => { response.writeHead(307, { location: "http://127.0.0.1:1/elsewhere" }).end(); });
  await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
  servers.push({ close: () => new Promise((resolve) => redirect.close(() => resolve())) });
  const dir = agentDir();
  writeMcp(dir, { web: { url: `http://127.0.0.1:${(redirect.address() as { port: number }).port}/mcp`, tools: {} } });
  await expect(connect(dir)).rejects.toThrow(/mcp web: could not connect/);
});

it("reports a server's tool error as a tool error, and bounds a large answer", async () => {
  const dir = agentDir();
  writeMcp(dir, { docs: local({ fail: approve("fail"), big: approve("big") }) });
  const mcp = await connect(dir);
  expect(await call(mcp, "mcp_docs_fail", {})).toEqual({ output: [{ type: "text", text: "the index is offline" }], isError: true });
  const big = text(await call(mcp, "mcp_docs_big", { size: 100_000 }));
  expect(Buffer.byteLength(big, "utf8")).toBeLessThanOrEqual(32 * 1024);
  expect(big).toMatch(/\[truncated\]$/);
});

it("refuses a server's request for a model completion instead of hanging or answering it", async () => {
  const dir = agentDir();
  writeMcp(dir, { docs: local({ sample: approve("sample") }) });
  const mcp = await connect(dir);
  const answer = JSON.parse(text(await call(mcp, "mcp_docs_sample", {})));
  expect(answer).toMatchObject({ code: -32601, message: "Method not found: sampling/createMessage" });
});

it("times out a slow call and stops it when the run is aborted", async () => {
  const dir = agentDir();
  writeMcp(dir, { docs: local({ slow: approve("slow") }) });
  const mcp = await connectMcp(loadMcpConfig(dir), { log: () => {}, reserved: [], callTimeoutMs: 200 });
  open.push(mcp);
  await expect(call(mcp, "mcp_docs_slow", { ms: 5_000 })).rejects.toThrow(/mcp docs: slow failed: .*time/i);
  await expect(call(mcp, "mcp_docs_slow", { ms: 5_000 })).rejects.toThrow(/disconnected/);
  const reopened = await connect(dir);
  const abort = new AbortController();
  const pending = call(reopened, "mcp_docs_slow", { ms: 5_000 }, abort.signal);
  abort.abort();
  await expect(pending).rejects.toThrow(/mcp docs: slow failed/);
});

it("fails a call after the server goes away, and never reconnects", async () => {
  const dir = agentDir();
  writeMcp(dir, { docs: local({ exit: approve("exit"), search: approve("search") }) });
  const logs: string[] = [];
  const mcp = await connect(dir, logs);
  await call(mcp, "mcp_docs_exit", {});
  await vi.waitFor(() => expect(logs).toContain("mcp docs: disconnected; restart the agent to reconnect"), { timeout: 1000, interval: 20 });
  expect(mcp.status()).toEqual([{ name: "docs", state: "disconnected" }]);
  await expect(call(mcp, "mcp_docs_search", { query: "x" })).rejects.toThrow(/mcp docs: the server disconnected; restart the agent to reconnect/);
});

it("stops a local server's whole process tree on close", async () => {
  const dir = agentDir();
  const pidfile = join(dir, "grandchild.pid");
  writeMcp(dir, { docs: local({}, { env: { FIXTURE_PIDFILE: "PIDFILE" } }) }, { PIDFILE: pidfile });
  const mcp = await connect(dir);
  const pid = Number(readFileSync(pidfile, "utf8"));
  expect(() => process.kill(pid, 0)).not.toThrow();
  await mcp.close();
  await expectGone(pid);
});

const refusals: { name: string; servers: Record<string, unknown>; secrets?: Record<string, string>; reserved?: string[]; error: RegExp }[] = [
  { name: "a changed tool", servers: { docs: local({ search: approve("search") }, { env: { FIXTURE_MODE: "MODE" } }) }, secrets: { MODE: "changed" }, error: new RegExp(`mcp docs: tool search \\[redacted\\] since you approved it; review it, then approve its new fingerprint ${approve("search", { description: "Search the docs, now with more." })}`) },
  { name: "an approved tool the server no longer offers", servers: { docs: local({ gone: "b".repeat(64) }) }, error: /mcp docs: approved tool gone is not offered by the server/ },
  { name: "an approved tool the server marks as a write", servers: { docs: local({ delete: approve("delete") }) }, error: /mcp docs: tool delete is marked by its server as a write; only reads can be approved/ },
  { name: "a name taken by a kit tool", servers: { docs: local({ search: approve("search") }) }, reserved: ["mcp_docs_search"], error: /mcp docs: tool search would be named mcp_docs_search, which another tool already uses/ },
  { name: "a server that exits during startup", servers: { docs: local({}, { env: { FIXTURE_MODE: "MODE" } }) }, secrets: { MODE: "crash" }, error: /mcp docs: could not connect/ },
  { name: "an unreachable remote server", servers: { web: { url: "http://127.0.0.1:1/mcp", tools: {} } }, error: /mcp web: could not connect/ },
];
it.each(refusals)("fails closed on $name, closing every server it started", async ({ servers, secrets, reserved, error }) => {
  const dir = agentDir();
  const pidfile = join(dir, "grandchild.pid");
  const logs: string[] = [];
  writeMcp(dir, { first: local({}, { env: { FIXTURE_PIDFILE: "PIDFILE" } }), ...servers }, { PIDFILE: pidfile, ...secrets });
  await expect(connectMcp(loadMcpConfig(dir), { log: (line) => logs.push(line), reserved: reserved ?? [] })).rejects.toThrow(error);
  await expectGone(Number(readFileSync(pidfile, "utf8")));
  // Stopping the servers it started is not reported as a disconnect.
  expect(logs.filter((line) => line.includes("disconnected"))).toEqual([]);
});

it("refuses two servers whose tools normalize to the same name", async () => {
  const dir = agentDir();
  writeMcp(dir, { docs: local({ search: approve("search") }) });
  const config = loadMcpConfig(dir);
  await expect(connectMcp([...config, { ...config[0]! }], { log: () => {}, reserved: [] })).rejects.toThrow(/which another tool already uses/);
});
