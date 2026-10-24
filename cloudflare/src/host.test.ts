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
import { agentHost, RETRY_MS, unavailable, type AgentHost, type HostOptions } from "./host.js";

const hosts: AgentHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const calls: string[][] = [];
// Answers the identity read and refuses everything else, as PR3's Container path does for writes.
const identity: Command = async (runtime, args) => {
  calls.push(args);
  return args[0] === "me" ? { outcome: "ok", data: { profile: { id: AGENT_ID } } } : unavailable(runtime, args);
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
    // The real Container command with a stand-in Container that answers the identity read.
    const sent: ContainerCall[] = [];
    const command = containerCommand({ config: "{}", call: async (body) => {
      sent.push(body);
      return Response.json({ stdout: JSON.stringify({ ok: true, data: { profile: { id: AGENT_ID } } }), stderr: "" });
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
    // The write was refused before it left the DO, so policy released it as failed.
    expect(Object.values(view.actions).map((action) => action.status)).toEqual(["failed"]);
    expect(sent).toEqual([{ args: ["--env", "staging", "me"], config: "{}" }]);
  });
});
