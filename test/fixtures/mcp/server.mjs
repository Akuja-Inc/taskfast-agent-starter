// A local MCP server for tests: newline-delimited JSON-RPC over stdio when run, and
// `handle` for an in-test Streamable HTTP server. FIXTURE_MODE switches behavior:
// "changed" (search's description differs), "paged" (tools/list in two pages),
// "crash" (exit on initialize, before answering). FIXTURE_PIDFILE makes it start a grandchild
// and write that child's pid there, so a test can check the whole tree stops.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const mode = process.env.FIXTURE_MODE ?? "";
const object = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
export const TOOLS = [
  { name: "search", title: "Search", description: mode === "changed" ? "Search the docs, now with more." : "Search the docs.", inputSchema: object({ query: { type: "string" } }, ["query"]), annotations: { readOnlyHint: true } },
  { name: "env", description: "The server's environment.", inputSchema: object() },
  { name: "slow", description: "Answers after `ms` milliseconds.", inputSchema: object({ ms: { type: "number" } }, ["ms"]) },
  { name: "fail", description: "Always reports a tool error.", inputSchema: object() },
  { name: "big", description: "Answers with `size` characters.", inputSchema: object({ size: { type: "number" } }, ["size"]) },
  { name: "exit", description: "Ends the server process.", inputSchema: object() },
  { name: "delete", description: "Deletes a document.", inputSchema: object({ id: { type: "string" } }, ["id"]), annotations: { destructiveHint: true } },
];
// Every call this process answered, by tool name, so a test can tell a refused call never arrived.
export const calls = [];
const text = (value) => ({ content: [{ type: "text", text: value }] });

export async function handle(message) {
  if (message.id === undefined) return undefined;
  const reply = (result) => ({ jsonrpc: "2.0", id: message.id, result });
  const { method, params = {} } = message;
  if (method === "initialize") {
    if (mode === "crash") process.exit(3);
    return reply({ protocolVersion: params.protocolVersion ?? "2025-11-25", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fixture", version: "1.0.0" } });
  }
  if (method === "ping") return reply({});
  if (method === "tools/list") {
    if (mode !== "paged") return reply({ tools: TOOLS });
    return params.cursor === "2" ? reply({ tools: TOOLS.slice(3) }) : reply({ tools: TOOLS.slice(0, 3), nextCursor: "2" });
  }
  if (method === "tools/call") {
    const args = params.arguments ?? {};
    calls.push(params.name);
    if (params.name === "search") return reply(text(`results for ${args.query}`));
    if (params.name === "env") return reply(text(JSON.stringify(process.env)));
    if (params.name === "slow") { await new Promise((done) => setTimeout(done, args.ms)); return reply(text("slow done")); }
    if (params.name === "fail") return reply({ ...text("the index is offline"), isError: true });
    if (params.name === "big") return reply(text("x".repeat(args.size)));
    if (params.name === "exit") { setTimeout(() => process.exit(0), 5); return reply(text("bye")); }
    return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `unknown tool ${params.name}` } };
  }
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${method}` } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.FIXTURE_PIDFILE) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(process.env.FIXTURE_PIDFILE, String(child.pid));
  }
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const response = await handle(JSON.parse(line));
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
