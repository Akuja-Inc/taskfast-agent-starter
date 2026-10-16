import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { afterEach, expect, it, vi } from "vitest";
import { connectMcp, type McpTools } from "./mcp.js";
import { toolHash, type McpServer } from "./mcp-config.js";

const opened: McpTools[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((item) => item.close()));
  for (const close of cleanup.splice(0).reverse()) await close();
});
const tool = { name: "read", description: "Read.", inputSchema: { type: "object", properties: {} } };
async function httpFixture(mode: "handshake" | "call" | "metadata" = "call") {
  let requestClosed = false;
  let initialized = false;
  const secret = "synthetic-secret-123";
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const message = JSON.parse(body);
    const reply = (result: unknown) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } });
    else if (message.method === "notifications/initialized") {
      initialized = true;
      if (mode !== "handshake") response.writeHead(202).end();
    } else if (message.method === "tools/list") reply({ tools: mode === "metadata" ? [{ ...tool, name: secret }] : [tool] });
    else if (message.method === "tools/call") response.on("close", () => { requestClosed = true; });
    else response.writeHead(202).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no fixture port");
  const config: McpServer = { name: "test", transport: "http", url: `http://127.0.0.1:${address.port}/mcp`, credentials: { Authorization: secret }, tools: mode === "metadata" ? {} : { read: toolHash(tool) } };
  return { config, secret, initialized: () => initialized, requestClosed: () => requestClosed };
}
const call = (mcp: McpTools, signal = new AbortController().signal) => mcp.tools[0]!.execute({} as never, { conversationId: ROOT_CONVERSATION_ID } as never, { abortSignal: signal } as never);

it("bounds the complete HTTP handshake, including the initialized notification", async () => {
  const fixture = await httpFixture("handshake");
  const pending = connectMcp([fixture.config], { log: () => {}, reserved: [], connectTimeoutMs: 80 }).then((mcp) => { opened.push(mcp); return mcp; });
  await expect(Promise.race([pending, delay(500).then(() => { throw new Error("fixture safety deadline"); })])).rejects.toThrow(/connection timed out/);
  expect(fixture.initialized()).toBe(true);
});

it.each(["timeout", "abort"] as const)("closes HTTP I/O and latches the server after call %s", async (reason) => {
  const fixture = await httpFixture();
  const mcp = await connectMcp([fixture.config], { log: () => {}, reserved: [], callTimeoutMs: reason === "timeout" ? 80 : 5000 });
  opened.push(mcp);
  const abort = new AbortController();
  const pending = call(mcp, abort.signal);
  const result = expect(pending).rejects.toThrow(/failed/);
  if (reason === "abort") { await delay(30); abort.abort(); }
  await result;
  await vi.waitFor(() => expect(fixture.requestClosed()).toBe(true));
  await expect(call(mcp)).rejects.toThrow(/disconnected/);
});

it("redacts credential-bearing discovery names before logging or rejecting them", async () => {
  const fixture = await httpFixture("metadata");
  const logs: string[] = [];
  await expect(connectMcp([fixture.config], { log: (line) => logs.push(line), reserved: [] })).rejects.toThrow(/credential/);
  expect(logs.join("\n")).not.toContain(fixture.secret);
});

it("cancels a connection attempt while its HTTP handshake is pending", async () => {
  const fixture = await httpFixture("handshake");
  const abort = new AbortController();
  const pending = connectMcp([fixture.config], { log: () => {}, reserved: [], signal: abort.signal });
  const result = expect(pending).rejects.toThrow(/abort/i);
  await vi.waitFor(() => expect(fixture.initialized()).toBe(true));
  abort.abort();
  await result;
});

it("joins the same cleanup when callers close concurrently", async () => {
  const script = `
    setInterval(() => {}, 1000);
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line); if(m.id===undefined)return;
      const result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:{tools:[]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+String.fromCharCode(10));
    });`;
  const mcp = await connectMcp([{ name: "local", transport: "stdio", command: process.execPath, args: ["-e", script], cwd: tmpdir(), credentials: {}, tools: {} }], { log: () => {}, reserved: [] });
  opened.push(mcp);
  let finished = false;
  const first = mcp.close().then(() => { finished = true; });
  try {
    await mcp.close();
    expect(finished).toBe(true);
  } finally { await first; }
});

it.skipIf(process.platform === "win32").each(["ignore", "inherit"])("reaps a crashed parent's descendants with %s pipes", async (stdio) => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-crash-"));
  const file = join(dir, "child.pid");
  let pid: number | undefined;
  cleanup.push(() => {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  });
  const script = `
    const {spawn} = require('node:child_process');
    const {writeFileSync} = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: ${JSON.stringify(stdio)}});
    writeFileSync(process.argv[1], String(child.pid));
    require('node:readline').createInterface({input: process.stdin}).on('line', line => {
      const m = JSON.parse(line); if (m.id === undefined) return;
      const result = m.method === 'initialize' ? {protocolVersion:'2025-11-25', capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}} : {tools:[]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result}) + String.fromCharCode(10));
      if (m.method === 'tools/list') setTimeout(() => process.exit(0), 50);
    });`;
  const logs: string[] = [];
  const mcp = await connectMcp([{ name: "local", transport: "stdio", command: process.execPath, args: ["-e", script, file], cwd: dir, credentials: {}, tools: {} }], { log: (line) => logs.push(line), reserved: [] });
  opened.push(mcp);
  pid = Number(readFileSync(file, "utf8"));
  await vi.waitFor(() => expect(logs.some((line) => line.includes("disconnected"))).toBe(true));
  await mcp.close();
  // Linux may retain a reparented zombie briefly; it is no longer executing.
  await vi.waitFor(() => {
    if (process.platform !== "linux") { expect(() => process.kill(pid!, 0)).toThrow(); return; }
    try { expect(readFileSync(`/proc/${pid}/status`, "utf8").split("\n").find((line) => line.startsWith("State:"))).toMatch(/State:\s+Z/); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  });
});
