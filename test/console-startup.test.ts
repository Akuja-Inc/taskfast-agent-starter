import { afterEach, expect, it, vi } from "vitest";
import { startConsole } from "../src/console.js";
import type { AgentRosterEntry, StartupAction } from "../src/console-lifecycle.js";

const open: Awaited<ReturnType<typeof startConsole>>[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((server) => server.close())); });
async function fixture(roster: AgentRosterEntry[], startup = (_request: StartupAction) => true) {
  const server = await startConsole({ port: 0, token: "fixture-token", env: "local", agents: () => [], roster: () => roster, startup });
  open.push(server);
  const url = `http://127.0.0.1:${server.port}`;
  const request = (path: string, method = "GET", body?: unknown) => fetch(url + path, { method, headers: { authorization: "Bearer fixture-token", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { url, request };
}

it("serves the page and complete roster with no ready agent", async () => {
  const roster: AgentRosterEntry[] = [
    { id: "slow", generation: 1, state: "starting", phase: "opening" },
    { id: "broken", generation: 2, state: "stopped", reason: "Could not connect" },
  ];
  const { url, request } = await fixture(roster);
  expect((await fetch(url)).status).toBe(200);
  expect(await (await request("/api/agents")).json()).toEqual({ env: "local", agents: roster });
});

it("accepts only generation-scoped lifecycle intent and returns without waiting for startup", async () => {
  const startup = vi.fn((_request: StartupAction) => true);
  const { request } = await fixture([{ id: "slow", generation: 3, state: "starting", phase: "opening" }], startup);
  expect((await request("/api/agents/slow/startup/cancel", "POST", { generation: 3 })).status).toBe(202);
  expect(startup).toHaveBeenCalledExactlyOnceWith({ id: "slow", generation: 3, action: "cancel" });
  expect((await request("/api/agents/slow/startup/cancel", "POST", { generation: 2 })).status).toBe(409);
  expect(startup).toHaveBeenCalledTimes(1);
  startup.mockReturnValue(false);
  expect((await request("/api/agents/slow/startup/retry", "POST", { generation: 3 })).status).toBe(409);
});

it("never acknowledges a model message or a ready view for a pending agent", async () => {
  const { request } = await fixture([{ id: "slow", generation: 1, state: "starting", phase: "opening" }]);
  for (const [path, method, body] of [
    ["/api/agents/slow", "GET", undefined],
    ["/api/agents/slow/stream", "GET", undefined],
    ["/api/agents/slow/messages", "POST", { requestId: "message-1", text: "Do work" }],
  ] as const) {
    const response = await request(path, method, body);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "agent is not ready" });
  }
  expect((await request("/api/agents/unknown")).status).toBe(404);
});

it("validates lifecycle inputs and applies the existing token and origin checks", async () => {
  const { url, request } = await fixture([{ id: "broken", generation: 1, state: "stopped", reason: "invalid config" }]);
  for (const generation of [undefined, "1", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect((await request("/api/agents/broken/startup/retry", "POST", { generation })).status).toBe(400);
  }
  expect((await fetch(`${url}/api/agents/broken/startup/retry`, { method: "POST", body: '{"generation":1}' })).status).toBe(401);
  expect((await fetch(`${url}/api/agents`, { headers: { authorization: "Bearer fixture-token", origin: "https://other.example" } })).status).toBe(403);
});
