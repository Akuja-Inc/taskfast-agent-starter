// The terminal UI against a throwaway host (test/fixtures/tui-host.mjs: temporary agent
// folders, real stores, scripted model, fake CLI). Run with `pnpm tui:test`.
import { afterAll, expect, spyOn, test } from "bun:test";
import type { ConsoleView } from "../console.js";
import { spawn } from "node:child_process";
import { testRender } from "@opentui/solid";
import { App } from "./app.js";

const ROOT = new URL("../../", import.meta.url);
const hosts: ReturnType<typeof spawn>[] = [];
afterAll(() => { for (const host of hosts) host.kill("SIGTERM"); });
// Starts one throwaway host; resolves with it and the console link it printed.
async function startHost() {
  const host = spawn("node", [new URL("test/fixtures/tui-host.mjs", ROOT).pathname], { stdio: ["ignore", "pipe", "inherit"] });
  hosts.push(host);
  const link = await new Promise<URL>((resolve, reject) => {
    let out = "";
    host.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const printed = /console: (\S+)/.exec(out);
      if (printed) resolve(new URL(printed[1]));
    });
    host.once("exit", (code) => reject(new Error(`tui-host exited with ${code}`)));
  });
  return { host, link };
}
const { link } = await startHost();
const token = link.hash.slice("#token=".length);

async function draw(width: number, height: number, origin = link.origin, key = token) {
  const opened: string[] = [];
  let quits = 0;
  const setup = await testRender(() => <App origin={origin} token={key} open={(url) => opened.push(url)} quit={() => { quits++; }} />, { width, height });
  // Renders until `seen` holds for the frame; network replies arrive between passes.
  async function until(seen: (frame: string) => boolean): Promise<string> {
    for (let tries = 0; tries < 200; tries++) {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).not.toContain(key);
      if (seen(frame)) return frame;
      await Bun.sleep(25);
    }
    throw new Error(`never drew it:\n${setup.captureCharFrame()}`);
  }
  return { setup, until, opened, quits: () => quits, keys: setup.mockInput };
}

test("draws a live agent and steers it through the console API", async () => {
  // Tall enough that the whole timeline, markdown reply included, stays in view.
  const { setup, until, keys, opened, quits } = await draw(130, 64);
  const timeline = await until((frame) => frame.includes("A new bid arrived"));
  expect(timeline).toContain("DEVELOPMENT · local TaskFast server · no real money");
  expect(timeline).toContain("Needs attention · 2");
  expect(timeline).toContain("UNCERTAIN accept:44444444-4444-4444-8444-444444444444");
  expect(timeline).toContain("DEAD-LETTERED event has no name");
  expect(timeline).toContain("[▸ 4 tool calls · 1 failed · 1 uncertain]");
  expect(timeline).toContain("Edit 12 product photos");
  expect(timeline).toContain("http://localhost:4000/tasks/11111111-1111-4111-8111-111111111111");
  expect(timeline).toContain("Ready to work? yes");
  // The markdown reply draws without its markers; raw HTML and a javascript: link stay text.
  expect(timeline).toContain("A new bid arrived on the copywriting job. I will wait for your check on the");
  expect(timeline).toContain("• The acceptance of bid 44444444 is uncertain and counted as spent");
  expect(timeline).toContain("  • read the task on the task page (https://example.com/tasks/22222222)");
  expect(timeline).toContain("1. Check the bid");
  expect(timeline).toContain("<script>alert(1)</script>");
  expect(timeline).toContain("[x](javascript:alert(1))");
  for (const marker of ["**", "```", "###", "`44444444`"]) expect(timeline).not.toContain(marker);

  // The first reply holds the tool calls: show them, then open its task.
  keys.pressKey("g");
  keys.pressEnter();
  const calls = await until((frame) => frame.includes("[▾ 4 tool calls"));
  expect(calls).toContain("message refused: you are not a party to this task");
  expect(calls).toContain("timed out waiting for the server");
  keys.pressKey("o");
  await until(() => opened.length > 0);
  expect(opened).toEqual(["http://localhost:4000/tasks/11111111-1111-4111-8111-111111111111"]);

  // Pause takes effect at once; freezing asks first.
  keys.pressKey("p");
  await until((frame) => frame.includes("● paused"));
  keys.pressKey("f");
  await until((frame) => frame.includes("Freeze spending?"));
  keys.pressKey("y");
  await until((frame) => frame.includes("SPENDING FROZEN") && frame.includes("● paused"));

  // A message waits while paused, then arrives as a YOU turn once resumed.
  keys.pressKey("m");
  await until((frame) => frame.includes("Your message to the agent"));
  await keys.typeText("Keep every job under $15.");
  keys.pressEnter();
  await until((frame) => frame.includes("Follow-up queued") && frame.includes("1 waiting"));
  keys.pressKey("p");
  await until((frame) => frame.includes("YOU") && frame.includes("Keep every job under $15.") && frame.includes("Understood."));

  // Mark the uncertain acceptance checked: one alert remains.
  keys.pressKey("c");
  await until((frame) => frame.includes("Needs attention · 1"));

  keys.pressKey("2");
  await until((frame) => frame.includes("What the agent reads every turn"));
  keys.pressKey("?");
  await until((frame) => frame.includes("quit the TUI; the agents keep running"));
  keys.pressKey("?");

  // q closes only the TUI: the renderer goes, the host keeps answering.
  keys.pressKey("q");
  for (let tries = 0; quits() === 0 && tries < 100; tries++) await Bun.sleep(20);
  expect(quits()).toBe(1);
  expect(setup.renderer.isDestroyed).toBe(true);
  expect((await fetch(new URL("/api/agents", link), { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
}, 60_000);

test("the focused composer sends steers, queue focus promotes by ID, and Briefing still confirms saving", async () => {
  const other = await startHost();
  const headers = { authorization: `Bearer ${other.link.hash.slice("#token=".length)}`, "content-type": "application/json" };
  const path = other.link.origin + "/api/agents/shop";
  const api = async (action: string, body?: unknown): Promise<ConsoleView> => {
    const response = await fetch(path + action, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(response.ok).toBe(true);
    return response.status === 204 ? api("") : await response.json() as ConsoleView;
  };
  const { setup, until, keys } = await draw(130, 48, other.link.origin, other.link.hash.slice("#token=".length));
  try {
    await until((frame) => frame.includes("A new bid arrived"));
    keys.pressKey("p");
    await until((frame) => frame.includes("● paused"));
    keys.pressKey("m");
    await until((frame) => frame.includes("Your message to the agent"));
    await keys.typeText("Steer from the focused input.");
    keys.pressKey("s", { ctrl: true });
    await until((frame) => frame.includes("Steer queued") && frame.includes("Queued messages · 1"));
    let current = await api("");
    expect(current.queuedMessages).toHaveLength(1);
    expect(current.queuedMessages[0]).toMatchObject({ text: "Steer from the focused input.", mode: "steer" }); // No typed Ctrl+S.

    keys.pressKey("m");
    await until((frame) => frame.includes("Your message to the agent"));
    await keys.typeText("A follow-up to promote.");
    keys.pressEnter();
    await until((frame) => frame.includes("Follow-up queued") && frame.includes("Queued messages · 2"));
    current = await api("");
    const original = current.queuedMessages.find((row) => row.mode === "followUp");
    expect(original).toBeDefined();
    keys.pressTab();
    keys.pressTab();
    keys.pressKey("j");
    keys.pressKey("s");
    await until((frame) => frame.includes("Message set to Steer."));
    current = await api("");
    expect(current.queuedMessages).toHaveLength(2);
    expect(current.queuedMessages.find((row) => row.requestId === original?.requestId)?.mode).toBe("steer");

    // Direct API steering uses the same live queue, even while paused.
    await api("/messages", { requestId: "smoke-direct", text: "Direct API steer.", steer: true });
    await until((frame) => frame.includes("Queued messages · 3"));
    keys.pressKey("p");
    await until((frame) => frame.includes("Queued messages · 0") && frame.includes("Direct API steer."));
    current = await api("");
    expect(current.timeline.filter((turn) => turn.kind === "operator").map((turn) => turn.text)).toEqual([
      "Steer from the focused input.", "A follow-up to promote.", "Direct API steer.",
    ]);

    // Editing the spending limit and Ctrl+S must still be a Briefing save, never a message.
    keys.pressKey("2");
    keys.pressTab();
    keys.pressKey("j");
    keys.pressEnter();
    await until(() => setup.renderer.currentFocusedEditor !== null);
    keys.pressKey("a", { ctrl: true }); // Start of the input, not select-all.
    keys.pressKey("k", { ctrl: true }); // Delete to its end.
    await keys.typeText("25");
    keys.pressEnter();
    await until((frame) => frame.includes("Unsaved changes") && setup.renderer.currentFocusedEditor === null);
    keys.pressKey("s", { ctrl: true });
    await until((frame) => frame.includes("Confirm spending change: Per job limit $20.00 → $25.00"));
    keys.pressKey("n");
    keys.pressKey("s", { ctrl: true });
    await until((frame) => frame.includes("Save agent.json and reopen only this agent?"));
    keys.pressKey("y");
    await until((frame) => frame.includes("Saved. Only this agent reopened."));
    current = await api("");
    expect(current.spec.limits?.perJobUsd).toBe(25);
    expect(current.queuedMessages).toHaveLength(0);
  } finally { setup.renderer.destroy(); other.host.kill("SIGTERM"); }
}, 60_000);

test("retries an admitted steer without changing ID or mode, and reports a real late-promotion 404", async () => {
  const other = await startHost();
  const headers = { authorization: `Bearer ${other.link.hash.slice("#token=".length)}`, "content-type": "application/json" };
  const path = other.link.origin + "/api/agents/shop";
  const { setup, until, keys } = await draw(90, 44, other.link.origin, other.link.hash.slice("#token=".length));
  const fetchReal = globalThis.fetch;
  const sent: unknown[] = [];
  let promotions = 0;
  const requests = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url === path + "/messages" && init?.method === "POST") {
      sent.push(JSON.parse(String(init.body)));
      const response = await fetchReal(input, init);
      if (sent.length === 1) throw new Error("Test dropped admission reply."); // Real admission, lost acknowledgement.
      return response;
    }
    if (url.startsWith(path + "/steer/")) {
      promotions++;
      // The UI selected a visible row, but Pi places it before the handler begins.
      await fetchReal(path + "/paused", { method: "POST", headers, body: JSON.stringify({ value: false }) });
      for (let i = 0; i < 200; i++) {
        const current = await (await fetchReal(path, { headers })).json() as ConsoleView;
        if (!current.queuedMessages.length) break;
        await Bun.sleep(10);
      }
      const response = await fetchReal(input, init);
      expect(response.status).toBe(404);
      return response;
    }
    return fetchReal(input, init);
  }, { preconnect: fetchReal.preconnect }));
  try {
    await until((frame) => frame.includes("A new bid arrived"));
    keys.pressKey("p");
    await until((frame) => frame.includes("● paused"));
    keys.pressKey("m");
    await until((frame) => frame.includes("Your message to the agent"));
    await keys.typeText("Keep this steer and its identity.");
    keys.pressKey("s", { ctrl: true });
    await until((frame) => frame.includes("Test dropped admission reply."));
    // The failed acknowledgement must leave the actual focused input and text intact.
    expect(setup.captureCharFrame()).toContain("Keep this steer and its identity.");
    keys.pressEnter(); // Retry with the other shortcut. It must still be a steer.
    await until((frame) => frame.includes("Steer queued"));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[1]).toMatchObject({ text: "Keep this steer and its identity.", steer: true });
    let current = await (await fetchReal(path, { headers })).json() as ConsoleView;
    expect(current.queuedMessages).toHaveLength(1);

    keys.pressKey("m");
    await until((frame) => frame.includes("Your message to the agent"));
    await keys.typeText("A late selected follow-up.");
    keys.pressEnter();
    await until((frame) => frame.includes("Follow-up queued"));
    expect(sent[2]).not.toHaveProperty("steer");
    expect(setup.captureCharFrame()).not.toContain("Queued messages");
    keys.pressTab();
    keys.pressTab(); // Queue focus opens the sidebar even without pressing i.
    await until((frame) => frame.includes("Queued messages · 2"));
    keys.pressKey("G"); // Select the last row even if the queue loaded after focus.
    await until((frame) => frame.includes("▶ Follow-up"));
    keys.pressKey("s");
    await until((frame) => frame.includes("The agent already has this message."));
    expect(promotions).toBe(1);
    await until((frame) => frame.includes("Queued messages · 0"));
    keys.pressKey("s"); // Stale ID never falls through to a different row or a send.
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("The agent already has this message.");
    expect(promotions).toBe(1);
    current = await (await fetchReal(path, { headers })).json() as ConsoleView;
    expect(current.timeline.filter((turn) => turn.kind === "operator").map((turn) => turn.text)).toEqual([
      "Keep this steer and its identity.", "A late selected follow-up.",
    ]);
  } finally { requests.mockRestore(); setup.renderer.destroy(); other.host.kill("SIGTERM"); }
}, 60_000);

test("withdraws queued follow-ups and steers while paused, restores visible focus, and never delivers them on resume", async () => {
  const other = await startHost();
  const key = other.link.hash.slice("#token=".length);
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  const path = other.link.origin + "/api/agents/shop";
  const current = async () => await (await fetch(path, { headers })).json() as ConsoleView;
  const post = async (action: string, body: unknown) => {
    expect((await fetch(path + action, { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(204);
  };
  const { setup, until, keys } = await draw(130, 48, other.link.origin, key);
  try {
    await until((frame) => frame.includes("A new bid arrived"));
    await post("/paused", { value: true });
    await post("/messages", { requestId: "withdraw-followup", text: "Withdraw this follow-up." });
    await post("/messages", { requestId: "withdraw-steer", text: "Withdraw this steer.", steer: true });
    const queued = await until((frame) => frame.includes("Queued messages · 2") && frame.includes("● paused"));
    expect(queued).toContain("Follow-up · s steer · w withdraw");
    expect(queued).toContain("Steer · w withdraw");
    expect(queued).toContain("Tab queue · s steer · w withdraw");
    keys.pressKey("?");
    await until((frame) => frame.includes("withdraw the selected queued follow-up or steer"));
    keys.pressKey("?");
    keys.pressTab();
    keys.pressTab();
    await until((frame) => frame.includes("▶ Follow-up"));
    keys.pressKey("w");
    await until((frame) => frame.includes("Message withdrawn.") && frame.includes("Queued messages · 1") && frame.includes("▶ Steer"));
    expect((await current()).queuedMessages.map((row) => row.requestId)).toEqual(["withdraw-steer"]);
    keys.pressKey("w");
    await until((frame) => frame.includes("Message withdrawn.") && frame.includes("Queued messages · 0"));
    expect((await current()).queuedMessages).toHaveLength(0);

    // Empty-queue success moves focus to the timeline, not a future replacement row.
    await post("/messages", { requestId: "kept-followup", text: "Keep this later follow-up." });
    await until((frame) => frame.includes("Queued messages · 1"));
    keys.pressKey("w");
    await setup.renderOnce();
    expect((await current()).queuedMessages.map((row) => row.requestId)).toEqual(["kept-followup"]);
    expect(setup.captureCharFrame()).not.toContain("▶ Follow-up");
    keys.pressKey("p");
    await until((frame) => frame.includes("Queued messages · 0") && frame.includes("Keep this later follow-up."));
    expect((await current()).timeline.filter((turn) => turn.kind === "operator").map((turn) => turn.text)).toEqual(["Keep this later follow-up."]);
  } finally { setup.renderer.destroy(); other.host.kill("SIGTERM"); }
}, 60_000);

test("keeps narrow queue withdrawal ID-bound through row shifts, pending repeats, and a lost acknowledgement", async () => {
  const other = await startHost();
  const key = other.link.hash.slice("#token=".length);
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  const path = other.link.origin + "/api/agents/shop";
  const fetchReal = globalThis.fetch;
  const current = async () => await (await fetchReal(path, { headers })).json() as ConsoleView;
  const post = async (action: string, body: unknown) => {
    expect((await fetchReal(path + action, { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(204);
  };
  const { setup, until, keys } = await draw(90, 48, other.link.origin, key);
  let release = () => {};
  const dispatch = new Promise<void>((resolve) => { release = resolve; });
  const deletions: string[] = [];
  const requests = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.startsWith(path + "/messages/") && init?.method === "DELETE") {
      deletions.push(url);
      expect(init.body).toBeUndefined();
      expect(new Headers(init.headers).has("content-type")).toBe(false);
      await dispatch;
      const response = await fetchReal(input, init);
      expect(response.status).toBe(204);
      throw new Error("Test dropped withdrawal reply.");
    }
    return fetchReal(input, init);
  }, { preconnect: fetchReal.preconnect }));
  try {
    await until((frame) => frame.includes("A new bid arrived"));
    await post("/paused", { value: true });
    await post("/messages", { requestId: "earlier-row", text: "Earlier row to remove." });
    await post("/messages", { requestId: "chosen-steer", text: "Chosen steer to withdraw.", steer: true });
    await post("/messages", { requestId: "untouched", text: "Do not withdraw the replacement row." });
    await until((frame) => frame.includes("● paused"));
    keys.pressTab();
    keys.pressTab();
    await until((frame) => frame.includes("Queued messages · 3"));
    keys.pressKey("j");
    await until((frame) => frame.includes("▶ Steer"));
    expect((await fetchReal(path + "/messages/earlier-row", { method: "DELETE", headers: { authorization: headers.authorization } })).status).toBe(204);
    await until((frame) => frame.includes("Queued messages · 2") && frame.includes("▶ Steer"));
    keys.pressKey("w");
    await until(() => deletions.length === 1);
    keys.pressKey("w");
    keys.pressKey("w");
    await setup.renderOnce();
    expect(deletions).toEqual([path + "/messages/chosen-steer"]); // Pending guard, not a row-index delete.
    release();
    await until((frame) => frame.includes("Test dropped withdrawal reply.") && frame.includes("Queued messages · 1"));
    expect((await current()).queuedMessages.map((row) => row.requestId)).toEqual(["untouched"]);
    keys.pressKey("w");
    await until((frame) => frame.includes("The agent already has this message."));
    expect(deletions).toHaveLength(1); // Stale selection never deletes the replacement row.
    expect(setup.captureCharFrame()).toContain("Selected message left the queue.");
    keys.pressKey("p");
    await until((frame) => frame.includes("Queued messages · 0"));
    const delivered = (await current()).timeline.filter((turn) => turn.kind === "operator").map((turn) => turn.text);
    expect(delivered).toEqual(["Do not withdraw the replacement row."]);
  } finally { release(); requests.mockRestore(); setup.renderer.destroy(); other.host.kill("SIGTERM"); }
}, 60_000);

test("reports a real withdrawal placement race as a notice without touching another queued message", async () => {
  const other = await startHost();
  const key = other.link.hash.slice("#token=".length);
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  const path = other.link.origin + "/api/agents/shop";
  const fetchReal = globalThis.fetch;
  const current = async () => await (await fetchReal(path, { headers })).json() as ConsoleView;
  const { setup, until, keys } = await draw(130, 48, other.link.origin, key);
  const statuses: number[] = [];
  const requests = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input) === path + "/messages/too-late" && init?.method === "DELETE") {
      // The row was visible at the keypress. Resume and let placement win at the host.
      await fetchReal(path + "/paused", { method: "POST", headers, body: JSON.stringify({ value: false }) });
      for (let tries = 0; tries < 200 && (await current()).queuedMessages.length; tries++) await Bun.sleep(10);
      const response = await fetchReal(input, init);
      statuses.push(response.status);
      return response;
    }
    return fetchReal(input, init);
  }, { preconnect: fetchReal.preconnect }));
  try {
    await until((frame) => frame.includes("A new bid arrived"));
    expect((await fetchReal(path + "/paused", { method: "POST", headers, body: JSON.stringify({ value: true }) })).status).toBe(204);
    expect((await fetchReal(path + "/messages", { method: "POST", headers, body: JSON.stringify({ requestId: "too-late", text: "Placement wins this withdrawal." }) })).status).toBe(204);
    await until((frame) => frame.includes("Queued messages · 1"));
    keys.pressTab();
    keys.pressTab();
    await until((frame) => frame.includes("▶ Follow-up"));
    keys.pressKey("w");
    await until((frame) => frame.includes("The agent already has this message."));
    expect(statuses).toEqual([409]);
    expect((await current()).timeline.filter((turn) => turn.kind === "operator").map((turn) => turn.text)).toEqual(["Placement wins this withdrawal."]);
    await fetchReal(path + "/paused", { method: "POST", headers, body: JSON.stringify({ value: true }) });
    await fetchReal(path + "/messages", { method: "POST", headers, body: JSON.stringify({ requestId: "next-message", text: "Keep the next message queued." }) });
    await until((frame) => frame.includes("Queued messages · 1") && frame.includes("Keep the next message queued."));
    keys.pressKey("w");
    await setup.renderOnce();
    expect(statuses).toEqual([409]);
    expect((await current()).queuedMessages.map((row) => row.requestId)).toEqual(["next-message"]);
  } finally { requests.mockRestore(); setup.renderer.destroy(); other.host.kill("SIGTERM"); }
}, 60_000);

test("folds the sidebar away below 100 columns", async () => {
  const { setup, until, keys } = await draw(90, 40);
  const narrow = await until((frame) => frame.includes("i sidebar"));
  expect(narrow).not.toContain("Ready to work?");
  expect(narrow).not.toContain("Needs attention");
  keys.pressKey("i");
  await until((frame) => frame.includes("Ready to work?"));
  keys.pressKey("a");
  await until((frame) => frame.includes("Needs attention"));
  setup.renderer.destroy();
}, 30_000);

test("drops a stale view for the can't-reach screen when the host stops", async () => {
  const other = await startHost();
  const { setup, until, keys } = await draw(120, 30, other.link.origin, other.link.hash.slice("#token=".length));
  // The sidebar, not the timeline: at 30 rows the long markdown reply scrolls past.
  await until((frame) => frame.includes("Ready to work? yes"));
  other.host.kill("SIGTERM");
  const down = await until((frame) => frame.includes("Can't reach the console"));
  expect(down).not.toContain("Ready to work? yes");
  keys.pressKey("r");
  await until((frame) => frame.includes("Can't reach the console"));
  setup.renderer.destroy();
}, 30_000);

test("says it can't reach the console, and retries", async () => {
  const { setup, until, keys } = await draw(100, 20, "http://127.0.0.1:9");
  const down = await until((frame) => frame.includes("Can't reach the console"));
  expect(down).toContain("r retry · q quit");
  keys.pressKey("r");
  await until((frame) => frame.includes("Can't reach the console"));
  setup.renderer.destroy();
}, 30_000);
