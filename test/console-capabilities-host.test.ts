import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import { runAgents } from "../src/run.js";
import { openMarketplaceAgent, type MarketplaceAgent } from "../src/core/agent.js";
import type { CapabilityView } from "../src/capability-types.js";
import { copyExample } from "./example.js";

const task = "11111111-1111-4111-8111-111111111111";
const event = { event_id: "22222222-2222-4222-8222-222222222222", event: "task_created", task_id: task };
function gate() { let release = () => {}; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
const files = [{ path: "research/SKILL.md", text: "---\nname: research\ndescription: Reference research\n---\nRead the task carefully.\n" }];

async function fixture(body: (kit: { url: URL; dir: string; agents: Map<string, MarketplaceAgent>; calls: string[]; writing: ReturnType<typeof gate>; started: () => boolean; stop: () => void; closedListeners: string[] }) => Promise<void>, held = false, rejectNew = false, tamper = false, openingGate?: ReturnType<typeof gate>) {
  const dir = mkdtempSync(join(tmpdir(), "console-capability-host-"));
  const stop = new AbortController();
  const writing = gate();
  const agents = new Map<string, MarketplaceAgent>();
  const calls: string[] = [];
  const closedListeners: string[] = [];
  let didWrite = false;
  let printed = "";
  for (const id of ["a", "b"]) {
    copyExample("brisk-poster", join(dir, id));
    mkdirSync(join(dir, id, ".taskfast"));
    writeFileSync(join(dir, id, ".taskfast", "config.json"), JSON.stringify({ environment: "local" }));
  }
  let first = true;
  const running = runAgents({
    agentsDir: dir, env: "local", signal: stop.signal, console: { port: 0 }, pingEveryMs: 60_000,
    log: (line) => { if (line.startsWith("console: ")) printed = line.slice(9); },
    listen: ({ runtime }) => ({ close: async () => { closedListeners.push(runtime.configPath.includes(join(dir, "a")) ? "a" : "b"); } }),
    command: async () => ({ outcome: "ok" }),
    openAgent: async (options) => {
      if (options.id === "a" && options.startHeld && openingGate) await openingGate.promise;
      if (rejectNew && options.id === "a" && existsSync(join(dir, "a", ".agents/skills/research"))) throw new Error("synthetic reopen failed");
      const faux = fauxProvider({ models: [{ id: "test" }] });
      const models = createModels(); models.setProvider(faux.provider);
      if (options.id === "a" && first && held) {
        first = false;
        faux.setResponses([fauxAssistantMessage([fauxToolCall("task_claim", { task_id: task })], { stopReason: "toolUse" }), fauxAssistantMessage("Claim finished.")]);
      } else if (tamper && options.id === "a" && options.startHeld) faux.setResponses([fauxAssistantMessage([fauxToolCall("task_claim", { task_id: task })], { stopReason: "toolUse" }), fauxAssistantMessage("Claimed.")]);
      else faux.setResponses([fauxAssistantMessage("Ready.")]);
      const agent = await openMarketplaceAgent({
        ...options, spec: { ...options.spec, model: "faux:test" }, models,
        command: async (_runtime, args) => {
          if (args[0] === "me") return { outcome: "ok", data: { profile: { id: "33333333-3333-4333-8333-333333333333" } } };
          if (args[0] === "task") { calls.push(`write ${options.id} ${options.startHeld ? "held" : "running"}`); didWrite = true; await writing.promise; return { outcome: "ok" }; }
          return { outcome: "ok" };
        },
      });
      calls.push(`open ${options.id}`);
      agents.set(options.id, agent);
      if (tamper && options.id === "a" && options.startHeld) rmSync(join(dir, "a", ".agents/skills/research/SKILL.md"));
      return agent;
    },
  });
  try {
    await vi.waitFor(() => expect(agents.size).toBe(2));
    await body({ url: new URL(printed), dir, agents, calls, writing, started: () => didWrite, stop: () => stop.abort(), closedListeners });
  } finally { writing.release(); openingGate?.release(); stop.abort(); await running; rmSync(dir, { recursive: true, force: true }); }
}
async function api(url: URL, id: string, action?: string, body?: unknown) {
  return fetch(new URL(`/api/agents/${id}/capabilities${action ? `/${action}` : ""}`, url), {
    method: action ? "POST" : "GET", headers: { authorization: `Bearer ${url.hash.slice(7)}`, "content-type": "application/json" },
    ...(action ? { body: JSON.stringify(body) } : {}),
  });
}
const view = async (url: URL, id = "a"): Promise<CapabilityView> => (await api(url, id)).json();

it("stages for the original agent, rejects stale revisions and retains drafts across cancelled waiting", async () => {
  await fixture(async ({ url, dir, agents, started }) => {
    await vi.waitFor(() => expect(started()).toBe(true));
    expect((await fetch(new URL("/api/agents/a/capabilities", url))).status).toBe(401);
    expect((await fetch(new URL("/api/agents/a/capabilities", url), { headers: { authorization: `Bearer ${url.hash.slice(7)}`, origin: "https://untrusted.invalid" } })).status).toBe(403);
    expect((await api(url, "../b")).status).toBe(404);
    const initial = await view(url);
    const stagedResponse = await api(url, "a", "stage-skill", { revision: initial.revision, files, enabled: true, replace: false });
    expect(stagedResponse.status).toBe(200);
    const staged: CapabilityView = await stagedResponse.json();
    expect(staged.pending).toBe(true);
    expect((await view(url, "b")).pending).toBe(false);
    expect(existsSync(join(dir, "a", ".agents", "skills", "research"))).toBe(false);
    const stale = await api(url, "a", "skill", { revision: "outdated", name: "research", operation: "disable" });
    expect(stale.status).toBe(409);
    const waiting = await api(url, "a", "apply", { revision: staged.revision, requestId: "cancel-this-apply" });
    expect(waiting.status).toBe(200);
    await vi.waitFor(async () => expect((await view(url)).apply.state).toBe("waiting"));
    await agents.get("a")!.deliver(event);
    expect((await agents.get("a")!.operator.events())[`event:${event.event_id}`]?.kind).toBe("admitted");
    const cancelled = await api(url, "a", "cancel", { revision: staged.revision, requestId: "cancel-this-apply" });
    expect(cancelled.status).toBe(200);
    await vi.waitFor(async () => expect((await view(url)).apply.state).toBe("cancelled"));
    expect((await view(url)).pending).toBe(true);
    expect(existsSync(join(dir, "a", ".agents", "skills", "research"))).toBe(false);
  }, true);
});

it("finishes the marketplace write, serializes Settings and reopens only the changed agent with its ledger intact", async () => {
  await fixture(async ({ url, dir, agents, calls, writing, started }) => {
    await vi.waitFor(() => expect(started()).toBe(true));
    const initial = await view(url);
    const stage: CapabilityView = await (await api(url, "a", "stage-skill", { revision: initial.revision, files, enabled: true, replace: false })).json();
    await api(url, "a", "apply", { revision: stage.revision, requestId: "safe-apply" });
    await vi.waitFor(async () => expect((await view(url)).apply.state).toBe("waiting"));
    const before = agents.get("a")!;
    await before.operator.setPaused(true);
    await before.operator.setFrozen(true);
    await before.deliver(event);
    const settings = await fetch(new URL("/api/agents/a/spec", url), { method: "PUT", headers: { authorization: `Bearer ${url.hash.slice(7)}`, "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(settings.status).not.toBe(204);
    expect(calls.filter((line) => line === "open a")).toHaveLength(1);
    writing.release();
    await vi.waitFor(async () => expect((await view(url)).apply.state).toBe("succeeded"), { timeout: 10_000 });
    expect(calls.filter((line) => line === "open a")).toHaveLength(2);
    expect(calls.filter((line) => line === "open b")).toHaveLength(1);
    expect(readFileSync(join(dir, "a", ".agents", "skills", "research", "SKILL.md"), "utf8")).toBe(files[0]!.text);
    expect((await agents.get("a")!.operator.state())).toMatchObject({ paused: true, frozen: true });
    expect(Object.values((await agents.get("a")!.status()).actions).map(({ status }) => status)).toEqual(["done"]);
    expect((await agents.get("a")!.operator.events())[`event:${event.event_id}`]?.kind).toBe("admitted");
    const final = await view(url);
    expect(final.activeRevision).not.toBeNull();
    expect(final.pending).toBe(false);
    // A lost response is retried by request identity, not a second close/open.
    await api(url, "a", "apply", { revision: stage.revision, requestId: "safe-apply" });
    expect(calls.filter((line) => line === "open a")).toHaveLength(2);
  }, true);
});

it("restores the prior files and registry after a failed reopen without disturbing its sibling", async () => {
  await fixture(async ({ url, dir, agents, calls }) => {
    await agents.get("a")!.operator.setPaused(true);
    const initial = await view(url);
    const staged: CapabilityView = await (await api(url, "a", "stage-skill", { revision: initial.revision, files, enabled: true, replace: false })).json();
    expect((await api(url, "a", "apply", { revision: staged.revision, requestId: "failed-reopen" })).status).toBe(200);
    await vi.waitFor(async () => expect((await view(url)).apply.state).toBe("failed"), { timeout: 10_000 });
    const recovered = await view(url);
    expect(recovered.pending).toBe(true);
    expect(recovered.activeRevision).toBe(initial.activeRevision);
    expect(existsSync(join(dir, "a", ".agents/skills/research"))).toBe(false);
    expect(calls.filter((line) => line === "open a")).toHaveLength(2);
    expect(calls.filter((line) => line === "open b")).toHaveLength(1);
    expect((await agents.get("a")!.operator.state()).paused).toBe(true);
  }, false, true);
});

it("never schedules a dormant replacement before its exact publication is verified and committed", async () => {
  await fixture(async ({ url, agents, calls }) => {
    const old = agents.get("a")!;
    const release = await old.quiesce(new AbortController().signal);
    try {
      await old.deliver(event);
      const initial = await view(url);
      const staged: CapabilityView = await (await api(url, "a", "stage-skill", { revision: initial.revision, files, enabled: true, replace: false })).json();
      await api(url, "a", "apply", { revision: staged.revision, requestId: "verify-before-running" });
      await vi.waitFor(async () => expect((await view(url)).apply.state).toBe("failed"), { timeout: 10_000 });
      expect(calls).not.toContain("write a held");
      expect(calls.filter((line) => line === "open a")).toHaveLength(3);
      expect(Object.values((await agents.get("a")!.status()).actions)).toEqual([]);
      expect((await view(url)).pending).toBe(true);
    } finally { await release(); }
  }, false, false, true);
});

it("closes sibling admissions before waiting for a hung capability reopen during shutdown", async () => {
  const opening = gate();
  await fixture(async ({ url, stop, closedListeners }) => {
    const initial = await view(url);
    const staged: CapabilityView = await (await api(url, "a", "stage-skill", { revision: initial.revision, files, enabled: true, replace: false })).json();
    await api(url, "a", "apply", { revision: staged.revision, requestId: "shutdown-during-open" });
    await vi.waitFor(async () => expect((await view(url)).apply.state).toBe("applying"));
    stop();
    // The replacement opener deliberately ignores abort until released below.
    // No slow manager or opener may keep the sibling stream admitting events.
    await vi.waitFor(() => expect(closedListeners).toContain("b"));
    opening.release();
  }, false, false, false, opening);
});
