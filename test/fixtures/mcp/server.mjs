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
  { name: "sample", description: "Asks the client for a model completion first.", inputSchema: object() },
  { name: "image", description: "Answers with a PNG image block and the same image as an embedded resource; with `bytes`, one PNG of that size.", inputSchema: object({ bytes: { type: "number" } }) },
  { name: "video", description: "Answers with a video blob resource; with `bytes`, pads the container header to that size.", inputSchema: object({ mimeType: { type: "string" }, bytes: { type: "number" } }) },
];
// The smallest bytes the host accepts as a PNG: the signature and a few bytes after it.
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fixture")]).toString("base64");
// Container headers only, like PNG above. These are signature fixtures, not playable clips.
export const VIDEO = {
  "video/mp4": Buffer.from("000000186674797069736f6d0000020069736f6d6d703432", "hex"),
  "video/quicktime": Buffer.from("0000001466747970717420200000000071742020", "hex"),
  "video/webm": Buffer.from("1a45dfa39f4286810142f7810142f2810442f381084282847765626d4287810442858102", "hex"),
};
const text = (value) => ({ content: [{ type: "text", text: value }] });
// Requests this server sends its client (stdio only), answered through `handle`.
let send = () => { throw new Error("no channel to the client"); };
const waiting = new Map();
let nextId = 1000;
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });

export async function handle(message) {
  if (message.method === undefined && waiting.has(message.id)) {
    waiting.get(message.id)(message);
    waiting.delete(message.id);
    return undefined;
  }
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
    if (params.name === "search") return reply(text(`results for ${args.query}`));
    if (params.name === "env") return reply(text(JSON.stringify(process.env)));
    if (params.name === "slow") { await new Promise((done) => setTimeout(done, args.ms)); return reply(text("slow done")); }
    if (params.name === "fail") return reply({ ...text("the index is offline"), isError: true });
    if (params.name === "big") return reply(text("x".repeat(args.size)));
    if (params.name === "image" && args.bytes) return reply({ content: [{ type: "image", mimeType: "image/png", data: Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(args.bytes - Buffer.from(PNG, "base64").length)]).toString("base64") }] });
    if (params.name === "image") return reply({ content: [{ type: "text", text: "Rendered:" }, { type: "image", mimeType: "image/png", data: PNG }, { type: "resource", resource: { uri: "file:///chart", mimeType: "image/png", blob: PNG } }] });
    if (params.name === "video") {
      const mimeType = args.mimeType ?? "video/mp4";
      const header = VIDEO[mimeType];
      const blob = Buffer.concat([header, Buffer.alloc(Math.max(0, (args.bytes ?? 0) - header.length))]).toString("base64");
      return reply({ content: [{ type: "resource", resource: { uri: "file:///clip", mimeType, blob } }] });
    }
    if (params.name === "exit") { setTimeout(() => process.exit(0), 5); return reply(text("bye")); }
    if (params.name === "sample") {
      const answer = await ask("sampling/createMessage", { messages: [{ role: "user", content: { type: "text", text: "hi" } }], maxTokens: 10 });
      return reply(text(JSON.stringify(answer.error ?? answer.result)));
    }
    return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `unknown tool ${params.name}` } };
  }
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${method}` } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.FIXTURE_PIDFILE) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(process.env.FIXTURE_PIDFILE, String(child.pid));
  }
  send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  // Messages are handled concurrently, so a call can wait on the client's answer to `ask`.
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    void handle(JSON.parse(line)).then((response) => { if (response) send(response); });
  }
}
