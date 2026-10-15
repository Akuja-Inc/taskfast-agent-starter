import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { toolHash } from "../src/core/mcp-config.js";
import { handle, TOOLS } from "./fixtures/mcp/server.mjs";

// The local MCP server the tests start: run by this Node, from the fixtures folder.
export const FIXTURE = join(import.meta.dirname, "fixtures/mcp/server.mjs");
// Waits up to a second for a process to be gone, as after a server's whole tree is stopped.
export async function expectGone(pid: number): Promise<void> {
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 1000, interval: 20 });
}
// The fingerprint the host logs for one of the fixture's tools, as its owner would approve it.
export function approve(name: string, changes: Partial<(typeof TOOLS)[number]> = {}): string {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no fixture tool ${name}`);
  return toolHash({ ...tool, ...changes });
}

// Writes an agent folder's mcp.json, and .mcp.env with mode 0600 when secrets are given.
export function writeMcp(dir: string, servers: Record<string, unknown>, secrets?: Record<string, string>): void {
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ servers }));
  if (!secrets) return;
  writeFileSync(join(dir, ".mcp.env"), Object.entries(secrets).map(([name, value]) => `${name}=${value}\n`).join(""));
  chmodSync(join(dir, ".mcp.env"), 0o600);
}

// The fixture's tools over Streamable HTTP on 127.0.0.1, answering each POST with JSON.
// Records each request's headers so a test can check which credentials arrived.
export async function httpFixture(): Promise<{ url: string; headers: Record<string, string | string[] | undefined>[]; close(): Promise<void> }> {
  const headers: Record<string, string | string[] | undefined>[] = [];
  const server = createServer(async (request, response) => {
    headers.push(request.headers);
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const reply = await handle(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!reply) { response.writeHead(202).end(); return; }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, headers,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
