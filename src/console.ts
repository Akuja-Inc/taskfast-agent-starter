import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PAGE } from "./console-page.js";
import type { MarketplaceAgent } from "./core/agent.js";
import type { AgentSpec, Env } from "./core/types.js";

// What the console needs from one running agent.
export interface ConsoleAgent {
  id: string;
  spec: AgentSpec;
  agent: Pick<MarketplaceAgent, "operator" | "status" | "transcript">;
}
export interface ConsoleOptions {
  // 0 picks a free port.
  port: number;
  // Required on every /api request as a bearer token. Never written into the page.
  token: string;
  env: Env;
  agents(): ConsoleAgent[];
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  const text = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(text);
}
function sameToken(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

// The local console: this machine only. A foreign Host is a rebound DNS name and a
// foreign Origin is another site's page; both are refused, and no CORS is offered.
export async function startConsole(o: ConsoleOptions): Promise<{ url: string; port: number; close(): Promise<void> }> {
  let port = 0;
  const own = () => [`127.0.0.1:${port}`, `localhost:${port}`];
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => send(res, 500, { error: error instanceof Error ? error.message : String(error) }));
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!own().includes(req.headers.host ?? "")) return send(res, 403, { error: "unknown host" });
    if (req.method === "OPTIONS") return send(res, 405, { error: "no cross-origin requests" });
    if (req.headers.origin !== undefined && !own().some((host) => req.headers.origin === `http://${host}`)) return send(res, 403, { error: "unknown origin" });
    const path = new URL(req.url ?? "/", "http://console").pathname;
    if (req.method === "GET" && path === "/") return send(res, 200, PAGE, "text/html");
    if (!sameToken(req.headers.authorization, o.token)) return send(res, 401, { error: "missing or wrong console token" });
    if (req.method === "GET" && path === "/api/agents") {
      return send(res, 200, { env: o.env, agents: o.agents().map(({ id, spec }) => ({ id, name: spec.character.name, role: spec.role })) });
    }
    return send(res, 404, { error: "not found" });
  }
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(o.port, "127.0.0.1", resolve); });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/#token=${o.token}`,
    port,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
