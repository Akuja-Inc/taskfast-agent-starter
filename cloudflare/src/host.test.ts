import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import type { Command } from "../../src/core/policy.js";
import { parseAgentSpec } from "../../src/core/spec.js";
import { openAgentStorage } from "../../src/core/storage.js";
import { example } from "../../test/example.js";
import { containerCommand, type ContainerCall } from "./container.js";
import { agentHost, RETRY_MS, type AgentHost, type HostOptions } from "./host.js";

const hosts: AgentHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const calls: string[][] = [];
// Answers the identity read and refuses everything else before acting.
const identity: Command = async (_runtime, args) => {
  calls.push(args);
  return args[0] === "me" ? { outcome: "ok", data: { profile: { id: AGENT_ID } } } : { outcome: "failed", error: "validation: refused in the test" };
};
function host(o: { responses?: FauxResponseStep[]; load?: HostOptions["load"]; command?: Command } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "do-host-"));
  dirs.push(dir);
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(o.responses ?? []);
  let opens = 0;
  const spec = parseAgentSpec({ ...example("careful-worker"), model: "faux:test", pollIntervalMinutes: 7 });
  const h = agentHost({
    id: "my-agent", env: "staging",
    load: o.load ?? (async () => ({ spec, models })),
    storage: () => { opens++; return openAgentStorage(join(dir, "state.sqlite")); },
    command: o.command ?? identity,
    folder: dir,
  });
  hosts.push(h);
  return { h, faux, opens: () => opens };
}
const get = (h: AgentHost, path: string, method = "GET") => h.fetch(new Request(`https://agent.example${path}`, { method }));

describe("agentHost", () => {
  it("opens the store once for concurrent requests and shows the agent", async () => {
    const { h, opens } = host();
    const [roster, detail] = await Promise.all([get(h, "/api/agents"), get(h, "/api/agents/my-agent")]);
    expect(opens()).toBe(1);
    expect(await roster.json()).toEqual({ env: "staging", agents: [{ id: "my-agent", generation: 1, state: "ready", role: "worker" }] });
    const view = await detail.json() as Record<string, unknown>;
    expect(detail.status).toBe(200);
    expect(view).toMatchObject({ id: "my-agent", env: "staging", actions: {}, notes: [] });
    expect(view.host).toBeUndefined();
  });

  it("shows a stopped agent with the reason, then opens once the problem is fixed", async () => {
    let broken = true;
    const models = createModels();
    models.setProvider(fauxProvider({ models: [{ id: "test" }] }).provider);
    const { h } = host({ load: async () => {
      if (broken) throw new Error("the TASKFAST_CONFIG secret is missing");
      return { spec: parseAgentSpec({ ...example("careful-worker"), model: "faux:test" }), models };
    } });
    const roster = await (await get(h, "/api/agents")).json();
    expect(roster).toEqual({ env: "staging", agents: [{ id: "my-agent", generation: 1, state: "stopped", reason: "the TASKFAST_CONFIG secret is missing" }] });
    expect((await get(h, "/api/agents/my-agent")).status).toBe(409);
    expect(await h.alarm()).toBe(RETRY_MS);
    broken = false;
    expect((await get(h, "/api/agents/my-agent")).status).toBe(200);
  });

  it("refuses every method but GET and every other agent", async () => {
    const { h } = host();
    expect((await get(h, "/api/agents/my-agent", "POST")).status).toBe(405);
    expect((await get(h, "/api/agents/other")).status).toBe(404);
    expect((await get(h, "/api/agents/%E0")).status).toBe(404);
  });

  it("runs one work check to the end in the alarm and returns the poll interval", async () => {
    // The real Container command with a stand-in Container: it answers the identity
    // read and refuses the bid the way the CLI does (exit 7, code validation).
    const sent: ContainerCall[] = [];
    const command = containerCommand({ config: "{}", folder: "/nonexistent", ready: async () => true, call: async (body) => {
      sent.push(body);
      return body.args[2] === "me"
        ? Response.json({ stdout: JSON.stringify({ ok: true, data: { profile: { id: AGENT_ID } } }), stderr: "" })
        : Response.json({ stdout: JSON.stringify({ ok: false, error: { code: "validation", message: "task is not open" } }), stderr: "", failure: "exit 7" });
    } });
    const { h, faux } = host({ command, responses: [
      fauxAssistantMessage([fauxToolCall("bid_create", { task_id: "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b", price: "10.00", pitch: "I can do this" }, { id: "c1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Bidding is unavailable for now."),
    ] });
    calls.length = 0;
    expect(await h.alarm()).toBe(7 * 60_000);
    // The turn finished inside the alarm: both model steps ran before it returned.
    expect(faux.state.callCount).toBe(2);
    const view = await (await get(h, "/api/agents/my-agent")).json() as { actions: Record<string, { status: string }> };
    // The CLI refused the bid, so policy released it as failed. It went out once.
    expect(Object.values(view.actions).map((action) => action.status)).toEqual(["failed"]);
    expect(sent.map((body) => body.args.slice(2, 4))).toEqual([["me"], ["bid", "create"]]);
  });

  describe("deliver", () => {
    const event = JSON.stringify({ event_id: "evt-1", event: "bid_received", task_id: "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b", data: { bid_id: "b1" } });
    it("admits an event, runs its turn once, and admits a redelivery without a second turn", async () => {
      const { h, faux } = host({ responses: [fauxAssistantMessage("Noted the bid."), fauxAssistantMessage("A second turn must not run.")] });
      const first = await h.deliver(event);
      expect(first.status).toBe(200);
      await first.work;
      expect(faux.state.callCount).toBe(1);
      const again = await h.deliver(event);
      expect(again.status).toBe(200);
      await again.work;
      expect(faux.state.callCount).toBe(1);
      const view = await (await get(h, "/api/agents/my-agent")).json() as { events: Record<string, { kind: string }> };
      expect(Object.keys(view.events)).toEqual(["event:evt-1"]);
    });
    it("answers a test delivery and an event without an id with 200 and stores nothing", async () => {
      const { h, faux } = host();
      expect((await h.deliver(JSON.stringify({ event: "test", timestamp: "2026-10-23T12:00:00Z", data: { message: "hi", agent_id: AGENT_ID } }))).status).toBe(200);
      expect((await h.deliver(JSON.stringify({ event: "saved_search_match", data: {} }))).status).toBe(200);
      expect(faux.state.callCount).toBe(0);
      const view = await (await get(h, "/api/agents/my-agent")).json() as { events: Record<string, unknown> };
      expect(view.events).toEqual({});
    });
    it("refuses a body that is not JSON", async () => {
      expect((await host().h.deliver("{")).status).toBe(400);
    });
    it("answers 503 when the agent cannot open, so the platform retries", async () => {
      const { h } = host({ load: async () => { throw new Error("the TASKFAST_CONFIG secret is missing"); } });
      expect((await h.deliver(event)).status).toBe(503);
    });
  });
});
