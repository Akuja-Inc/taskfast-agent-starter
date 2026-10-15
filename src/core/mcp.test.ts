import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { afterEach, expect, it } from "vitest";
import { approve, FIXTURE, httpCalls, httpFixture, writeMcp } from "../../test/mcp-fixture.js";
import { connectMcp, type McpTools } from "./mcp.js";
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

it("has no tools and starts nothing without servers", async () => {
  const mcp = await connect(agentDir());
  expect(mcp.tools).toEqual([]);
  expect(mcp.prompt).toBeUndefined();
});

it("exposes only approved tools over stdio, logs the others with their fingerprints and calls the server", async () => {
  const dir = agentDir();
  writeMcp(dir, { docs: local({ search: approve("search") }) });
  const logs: string[] = [];
  const mcp = await connect(dir, logs);
  expect(mcp.tools.map((tool) => tool.name)).toEqual(["mcp_docs_search"]);
  expect(mcp.tools[0]).toMatchObject({ replay: "unsafe", executionMode: "sequential" });
  expect(mcp.tools[0]!.description).toBe("From MCP server docs, approved by your operator as a read: Search the docs.");
  expect(logs).toContain("mcp docs: tools mcp_docs_search");
  expect(logs).toContain(`mcp docs: tool env is not approved; to approve it, add "env": "${approve("env")}" to servers.docs.tools in mcp.json`);
  expect(mcp.prompt).toContain("mcp_docs_search");
  expect(await call(mcp, "mcp_docs_search", { query: "bonds" })).toEqual({ output: [{ type: "text", text: "results for bonds" }], isError: false });
});

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
  expect(http.headers.every((headers) => headers.authorization === "Bearer web-token")).toBe(true);
  expect(httpCalls).toContain("search");
});

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
  expect(big.length).toBeLessThan(33_000);
  expect(big).toMatch(/\[truncated 67232 characters\]$/);
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
  const abort = new AbortController();
  const pending = call(mcp, "mcp_docs_slow", { ms: 5_000 }, abort.signal);
  abort.abort();
  await expect(pending).rejects.toThrow(/mcp docs: slow failed/);
});

it("fails a call after the server goes away, and never reconnects", async () => {
  const dir = agentDir();
  writeMcp(dir, { docs: local({ exit: approve("exit"), search: approve("search") }) });
  const logs: string[] = [];
  const mcp = await connect(dir, logs);
  await call(mcp, "mcp_docs_exit", {});
  for (let wait = 0; wait < 50 && !logs.some((line) => line.includes("disconnected")); wait++) await sleep(20);
  expect(logs).toContain("mcp docs: disconnected; restart the agent to reconnect");
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
  for (let wait = 0; wait < 50; wait++) {
    try { process.kill(pid, 0); } catch { break; }
    await sleep(20);
  }
  expect(() => process.kill(pid, 0)).toThrow();
});

const refusals: { name: string; servers: (dir: string) => Record<string, unknown>; secrets?: Record<string, string>; reserved?: string[]; error: RegExp }[] = [
  { name: "a changed tool", servers: () => ({ docs: local({ search: approve("search") }, { env: { FIXTURE_MODE: "MODE" } }) }), secrets: { MODE: "changed" }, error: new RegExp(`mcp docs: tool search changed since you approved it; review it, then approve its new fingerprint ${approve("search", { description: "Search the docs, now with more." })}`) },
  { name: "an approved tool the server no longer offers", servers: () => ({ docs: local({ gone: "b".repeat(64) }) }), error: /mcp docs: approved tool gone is not offered by the server/ },
  { name: "an approved tool the server marks as a write", servers: () => ({ docs: local({ delete: approve("delete") }) }), error: /mcp docs: tool delete is marked by its server as a write; only reads can be approved/ },
  { name: "a name taken by a kit tool", servers: () => ({ docs: local({ search: approve("search") }) }), reserved: ["mcp_docs_search"], error: /mcp docs: tool search would be named mcp_docs_search, which another tool already uses/ },
  { name: "a server that exits during startup", servers: () => ({ docs: local({}, { env: { FIXTURE_MODE: "MODE" } }) }), secrets: { MODE: "crash" }, error: /mcp docs: could not connect/ },
  { name: "an unreachable remote server", servers: () => ({ web: { url: "http://127.0.0.1:1/mcp", tools: {} } }), error: /mcp web: could not connect/ },
];
it.each(refusals)("fails closed on $name, closing every server it started", async ({ servers: build, secrets, reserved, error }) => {
  const dir = agentDir();
  const pidfile = join(dir, "grandchild.pid");
  writeMcp(dir, { first: local({}, { env: { FIXTURE_PIDFILE: "PIDFILE" } }), ...build(dir) }, { PIDFILE: pidfile, ...secrets });
  await expect(connectMcp(loadMcpConfig(dir), { log: () => {}, reserved: reserved ?? [] })).rejects.toThrow(error);
  const pid = Number(readFileSync(pidfile, "utf8"));
  for (let wait = 0; wait < 50; wait++) {
    try { process.kill(pid, 0); } catch { break; }
    await sleep(20);
  }
  expect(() => process.kill(pid, 0)).toThrow();
});

it("refuses two servers whose tools normalize to the same name", async () => {
  const dir = agentDir();
  writeMcp(dir, { docs: local({ search: approve("search") }) });
  const config = loadMcpConfig(dir);
  await expect(connectMcp([...config, { ...config[0]! }], { log: () => {}, reserved: [] })).rejects.toThrow(/which another tool already uses/);
});
