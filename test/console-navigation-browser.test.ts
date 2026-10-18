import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityView } from "../src/capability-types.js";
import { PAGE } from "../src/console-page.js";
import { startConsole, type ConsoleAgent, type ConsoleView } from "../src/console.js";
import { initialOperator } from "../src/core/operator.js";
import { browser, browserPath } from "./browser.js";

// Optional integration coverage. No browser dependency, model, store, CLI or account is used.
const token = "a".repeat(64);
const task = "11111111-1111-4111-8111-111111111111";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function capabilities(id: string): CapabilityView {
  const skill = { name: "research", description: "Read source material.", enabled: true, files: [{ path: "SKILL.md", text: "---\nname: research\ndescription: Read source material.\n---\nRead the supplied sources." }] };
  const server = { name: "catalog", config: { url: "https://catalog.invalid/mcp", headers: { Authorization: "CATALOG_TOKEN" } }, enabled: true, credentials: ["CATALOG_TOKEN"], approved: [{ name: "search", hash: "synthetic-read-hash" }] };
  return { agentDir: "/fixture/agents/" + id, revision: "b".repeat(64), activeRevision: "a".repeat(64), skills: [structuredClone(skill)], activeSkills: [skill], servers: [structuredClone(server)], activeServers: [server], credentials: ["CATALOG_TOKEN"], credentialChanges: [], pending: true, apply: { state: "idle" } };
}

async function fixture() {
  const calls: { agent: string; action: string; body: unknown }[] = [];
  const at = Date.UTC(2026, 0, 2);
  const transcript: Message[] = [];
  const result = (index: number, text: string): Message => ({ role: "toolResult", toolCallId: "call-" + index, toolName: "task_get", content: [{ type: "text", text }], isError: false, timestamp: at + index * 1000 + 2 });
  // More than two initial viewport windows. Turn zero starts pending for a live result update.
  for (let index = 0; index < 28; index++) {
    transcript.push(
      { role: "user", content: "Marketplace event:\n" + JSON.stringify({ event_id: "event-" + index, event: "task.created", task_id: task, text: "Event fixture " + index }), timestamp: at + index * 1000 },
      fauxAssistantMessage([fauxText("Response fixture " + index), fauxToolCall("task_get", { task_id: task }, { id: "call-" + index })], { stopReason: "toolUse", timestamp: at + index * 1000 + 1 }),
    );
    if (index) transcript.push(result(index, '{"task":{"title":"Synthetic task","status":"open"}}'));
  }
  const listeners = new Set<() => void>();
  const record = (id: string, action: string) => async (...body: unknown[]) => { calls.push({ agent: id, action, body }); };
  const agents: ConsoleAgent[] = ["alpha", "beta"].map((id) => ({
    id,
    spec: { role: "worker", model: "faux:fixture", instructions: "You are " + id + ", a careful copy editor.", dials: { competence: 0.9, diligence: 0.95, priceSensitivity: 0.5, temperament: "exacting" }, limits: { perJobUsd: 20, dailyUsd: 50 } },
    saveSpec: record(id, "saveSpec"),
    agent: {
      status: async () => ({ identity: { env: "local", agentId: "33333333-3333-4333-8333-333333333333" }, actions: {}, spend: {}, memory: [] }),
      transcript: async () => transcript,
      changes: (listener) => { listeners.add(listener); return () => void listeners.delete(listener); },
      operator: {
        state: async () => initialOperator(), events: async () => ({}), queued: async () => [],
        steer: async (requestId) => { calls.push({ agent: id, action: "steer", body: requestId }); return "steered"; },
        withdraw: async (requestId) => { calls.push({ agent: id, action: "withdraw", body: requestId }); return "withdrawn"; },
        setFrozen: record(id, "setFrozen"), setPaused: record(id, "setPaused"), message: record(id, "message"),
        addOrder: record(id, "addOrder"), removeOrder: record(id, "removeOrder"), replaceOrder: record(id, "replaceOrder"), markChecked: record(id, "markChecked"), retryEvent: record(id, "retryEvent"),
      },
    },
  }));
  const views: Record<string, CapabilityView> = { alpha: capabilities("alpha"), beta: capabilities("beta") };
  const host = await startConsole({ port: 0, token, env: "local", agents: () => agents, coalesceMs: 5,
    roster: () => agents.map(({ id }) => ({ id, name: id === "alpha" ? "Alpha" : "Beta", state: "ready", generation: 1 })),
    capabilities: (id) => {
      const view = views[id];
      return view ? { view: async () => structuredClone(view), command: async (action, body) => {
        calls.push({ agent: id, action, body });
        if (action === "preview-taskfast") view.skillPreview = { previewId: "synthetic-preview", skill: { name: "taskfast-agent", description: "Synthetic CLI guidance", enabled: true, files: [{ path: "SKILL.md", text: "Synthetic preview, not the installed CLI." }] } };
        else throw new Error("Unexpected navigation mutation: " + action);
        return structuredClone(view);
      } } : undefined;
    },
  });
  cleanup.push(host.close);
  const base = "http://127.0.0.1:" + host.port;
  const response = await fetch(base + "/agents/alpha");
  expect(response.status).toBe(200); expect(await response.text()).toBe(PAGE);
  const view: ConsoleView = await (await fetch(base + "/api/agents/alpha", { headers: { authorization: "Bearer " + token } })).json();
  expect(view.timeline).toHaveLength(28);
  for (const turn of view.timeline) expect(turn.id).toMatch(/^[a-f0-9]{64}$/);
  return { base, calls, views, timeline: view.timeline, settleFirst: () => { transcript.splice(2, 0, result(0, '{"failed":"Synthetic live result arrived"}')); listeners.forEach((listener) => listener()); } };
}

const instructionsLabel = "Instructions (INSTRUCTIONS.md): who the agent is, its business, goals and budget";
const cap = (screen = "", item = "", step = 0) => "/agents/alpha?" + new URLSearchParams({ tab: "capabilities", ...(screen ? { screen } : {}), ...(item ? { item } : {}), ...(step ? { step: String(step) } : {}) }).toString();

describe.skipIf(!browserPath)("console URL navigation in Chromium", () => {
  it("pushes every agent, page and panel change and restores older panels after copy, reload and live commits", async () => {
    const f = await fixture();
    const page = await browser(f.base + "/agents/alpha#token=" + token, cleanup);
    await page.until("document.querySelectorAll('article.turn').length === 12");
    expect(await page.path()).toBe("/agents/alpha");
    expect(await page.evaluate("location.hash")).toBe("");
    await page.screenshot("timeline-before");
    await page.push("document.querySelector('article.turn:last-of-type .calls-chip').click()", "/agents/alpha?" + new URLSearchParams({ open: f.timeline[27].id + ":call-27" }));
    const single = await page.path();
    await page.push("document.querySelector('article.turn:last-of-type > .head').click()", single + "&raw=" + f.timeline[27].id);
    await page.push("document.querySelector('article.turn:last-of-type .calls-chip').click()", "/agents/alpha?raw=" + f.timeline[27].id);
    await page.push("document.querySelector('article.turn:last-of-type > .head').click()", "/agents/alpha");
    await page.evaluate("history.back()");
    await page.until("document.querySelector('article.turn:last-of-type > .head[aria-expanded=true]') !== null && document.querySelectorAll('.calls').length === 0");
    await page.evaluate("history.back()");
    await page.until("document.querySelector('article.turn:last-of-type > .head[aria-expanded=true]') !== null && document.querySelectorAll('.calls').length === 1");
    await page.evaluate("history.go(2)");
    await page.until("location.search === '' && document.querySelectorAll('.calls').length === 0 && document.querySelectorAll('article.turn > .head[aria-expanded=true]').length === 0");
    await page.push("navTest.click('Settings')", "/agents/alpha?tab=settings");
    await page.push("navTest.click('Capabilities')", cap());
    await page.until("document.querySelector('[data-cap-name=catalog]') !== null");
    await page.push("navTest.agent('beta')", "/agents/beta?tab=capabilities");
    await page.until("document.body.innerText.includes('Capabilities · Beta')");
    await page.evaluate("history.back()");
    await page.until("document.body.innerText.includes('Capabilities · Alpha')");
    expect(await page.path()).toBe(cap());
    await page.evaluate("history.forward()");
    await page.until("document.body.innerText.includes('Capabilities · Beta')");

    const query = new URLSearchParams();
    for (const index of [0, 3, 9, 27]) query.append("open", f.timeline[index].id + ":call-" + index);
    for (const index of [0, 3, 9, 27]) query.append("raw", f.timeline[index].id);
    const copied = "/agents/alpha?" + query;
    // A copied link opens in a new tab without relying on the first tab's in-memory state.
    const restored = await page.open(f.base + copied + "#token=" + token);
    await restored.until("document.querySelectorAll('article.turn').length === 28 && document.querySelectorAll('.calls').length === 4 && document.querySelectorAll('article.turn > .head[aria-expanded=true]').length === 4");
    expect(await restored.path()).toBe(copied);
    expect(await restored.evaluate("document.querySelector('article.turn[data-i=\"0\"] .call').classList.contains('pending')")).toBe(true);
    f.settleFirst();
    await restored.until("document.querySelector('article.turn[data-i=\"0\"] .call.failed')?.textContent.includes('Synthetic live result arrived')");
    expect(await restored.path()).toBe(copied);
    await restored.screenshot("timeline-restored-after");
    await restored.reload();
    await restored.until("document.querySelectorAll('.calls').length === 4 && document.querySelectorAll('article.turn > .head[aria-expanded=true]').length === 4");
    expect(await restored.path()).toBe(copied);
    expect(await restored.evaluate("document.querySelector('article.turn[data-i=\"0\"] .call.failed')?.textContent.includes('Synthetic live result arrived')")).toBe(true);
    expect(f.calls).toEqual([]); expect(page.writes).toEqual([]); expect(restored.writes).toEqual([]);
    expect(page.errors).toEqual([]); expect(restored.errors).toEqual([]);
  }, 60_000);

  it("keeps dirty Settings URL and form on cancelled Back and discards only after acceptance", async () => {
    const f = await fixture();
    const page = await browser(f.base + "/agents/alpha#token=" + token, cleanup);
    await page.until("document.querySelector('nav') !== null");
    await page.push("navTest.click('Settings')", "/agents/alpha?tab=settings");
    await page.until("document.querySelector('#poll-interval') !== null");
    await page.evaluate("navTest.input(" + JSON.stringify(instructionsLabel) + ", 'PRIVATE-SETTINGS-DRAFT', 'change')");
    page.acceptDialogs(false);
    const count = page.dialogs.length;
    await page.evaluate("history.back()");
    await expect.poll(() => page.dialogs.length).toBe(count + 1);
    await page.until("location.search === '?tab=settings'");
    expect(page.dialogs.at(-1)).toContain("Settings");
    expect(await page.evaluate("document.querySelector('main textarea').value")).toBe("PRIVATE-SETTINGS-DRAFT");
    expect(await page.path()).toBe("/agents/alpha?tab=settings");
    await page.screenshot("settings-back-cancelled");
    page.acceptDialogs(true);
    await page.evaluate("history.back()");
    await page.until("location.search === '' && document.querySelector('nav a[aria-current=page]')?.textContent === 'Timeline'");
    await page.evaluate("history.forward()");
    await page.until("document.querySelector('main textarea') !== null");
    expect(await page.evaluate("document.querySelector('main textarea').value")).toBe("You are alpha, a careful copy editor.");
    expect(f.calls).toEqual([]); expect(page.writes).toEqual([]); expect(page.errors).toEqual([]);
  }, 45_000);

  it("restores capability screens and installed server steps without replaying tests, consent, approvals or preview POSTs", async () => {
    const f = await fixture();
    const page = await browser(f.base + cap() + "#token=" + token, cleanup);
    await page.until("document.querySelector('[data-cap-name=catalog]') !== null");
    await page.push("document.querySelector('[aria-label=\"Inspect skill research\"]').click()", cap("skill", "research"));
    await page.until("document.querySelector('.cap-detail h2')?.textContent === 'research'");
    await page.reload();
    await page.until("document.querySelector('.cap-detail h2')?.textContent === 'research'");
    expect(await page.path()).toBe(cap("skill", "research"));
    await page.push("navTest.click('Back to capabilities')", cap());
    await page.push("document.querySelector('[aria-label=\"Manage server catalog\"]').click()", cap("server", "catalog"));
    await page.push("navTest.click('Continue to test and review tools')", cap("server", "catalog", 1));
    expect(await page.evaluate("[...document.querySelectorAll('button')].find(node => node.textContent === 'Test connection').disabled")).toBe(true);
    expect(await page.evaluate("document.querySelector('.cap-check input').checked")).toBe(false);
    await page.push("navTest.click('Continue to review and save')", cap("server", "catalog", 2));
    expect(await page.evaluate("[...document.querySelectorAll('button')].find(node => node.textContent === 'Save and enable after apply').disabled")).toBe(true);
    await page.reload();
    await page.until("document.querySelector('.cap-steps [aria-current=step]')?.textContent === '3. Review and save'");
    expect(await page.path()).toBe(cap("server", "catalog", 2));
    expect(await page.evaluate("document.body.innerText.includes('https://catalog.invalid/mcp') && document.body.innerText.includes('Tool access after apply: none')")).toBe(true);
    expect(await page.evaluate("[...document.querySelectorAll('button')].find(node => node.textContent === 'Save and enable after apply').disabled")).toBe(true);
    await page.push("navTest.click('Back to test and review tools')", cap("server", "catalog", 1));
    await page.reload();
    await page.until("document.querySelector('.cap-steps [aria-current=step]')?.textContent === '2. Test and review tools'");
    expect(await page.evaluate("document.querySelector('.cap-check input').checked")).toBe(false);
    await page.push("navTest.click('Back to capabilities')", cap());
    await page.push("navTest.click('Review changes')", cap("review"));
    await page.until("document.querySelector('.cap-detail h2')?.textContent === 'Review capability changes'");
    await page.reload();
    await page.until("document.querySelector('.cap-detail h2')?.textContent === 'Review capability changes'");
    expect(await page.path()).toBe(cap("review"));
    expect(await page.evaluate("[...document.querySelectorAll('button')].find(node => node.textContent === 'Apply when idle').disabled")).toBe(true);
    await page.push("navTest.click('Back to capabilities')", cap());
    await page.push("navTest.click('Import folder')", cap("import"));
    await page.until("document.querySelector('input[type=file]') !== null");
    await page.reload();
    await page.until("document.body.innerText.includes('Folder uploads are temporary')");
    expect(await page.path()).toBe(cap("import"));
    await page.push("navTest.click('Back to capabilities')", cap());
    await page.push("navTest.click('Add TaskFast skill')", cap("taskfast"));
    await page.until("document.body.innerText.includes('Preview ready.')");
    expect(f.calls).toEqual([{ agent: "alpha", action: "preview-taskfast", body: { revision: "b".repeat(64) } }]);
    await page.reload();
    await page.until("document.body.innerText.includes('TaskFast previews are temporary')");
    expect(await page.path()).toBe(cap("taskfast"));
    await page.go(f.base + cap("credential", "CATALOG_TOKEN"));
    await page.until("document.querySelector('.cap-detail h2')?.textContent === 'Manage credential binding CATALOG_TOKEN'");
    expect(f.calls).toHaveLength(1); expect(page.writes).toHaveLength(1); expect(page.errors).toEqual([]);
  }, 60_000);

  it("keeps dirty capability config on cancelled Back across a reload boundary and discards only after accepted Back", async () => {
    const f = await fixture();
    const page = await browser(f.base + "/agents/alpha#token=" + token, cleanup);
    await page.until("[...document.querySelectorAll('aside a')].some(node => node.textContent === 'Edit in Settings')");
    expect(await page.evaluate("[...document.querySelectorAll('aside a')].find(node => node.textContent === 'Edit in Settings').getAttribute('href')")).toBe("/agents/alpha?tab=settings");
    await page.push("navTest.click('Edit in Settings')", "/agents/alpha?tab=settings");
    await page.until("document.querySelector('#poll-interval') !== null");
    await page.push("navTest.click('Capabilities')", cap());
    await page.until("document.querySelector('[data-cap-name=catalog]') !== null");
    await page.reload();
    await page.until("document.querySelector('[data-cap-name=catalog]') !== null");
    expect(await page.path()).toBe(cap());
    await page.push("document.querySelector('[aria-label=\"Manage server catalog\"]').click()", cap("server", "catalog"));
    await page.evaluate("navTest.input('Remote URL', 'https://private-draft.invalid/mcp'); navTest.input('Configured · enter replacement', 'PRIVATE-CREDENTIAL-DRAFT')");
    page.acceptDialogs(false);
    const count = page.dialogs.length;
    await page.evaluate("history.back()");
    await expect.poll(() => page.dialogs.length).toBe(count + 1);
    await page.until("location.pathname + location.search === " + JSON.stringify(cap("server", "catalog")));
    expect(page.dialogs.at(-1)).toContain("unsaved capability");
    expect(await page.evaluate("document.querySelector('input[type=url]').value")).toBe("https://private-draft.invalid/mcp");
    expect(await page.evaluate("document.querySelector('input[type=password]').value")).toBe("PRIVATE-CREDENTIAL-DRAFT");
    expect(await page.evaluate("[location.href, ...Object.values(sessionStorage), ...Object.values(localStorage)].some(value => value.includes('PRIVATE-CREDENTIAL-DRAFT') || value.includes('private-draft.invalid'))")).toBe(false);
    // Traverse to a pre-reload entry too. Resetting the navigation index on reload
    // aliases this entry with the editor and corrupts the cancellation recovery.
    await page.evaluate("history.go(-2)");
    await expect.poll(() => page.dialogs.length).toBe(count + 2);
    await page.until("location.pathname + location.search === " + JSON.stringify(cap("server", "catalog")));
    expect(await page.evaluate("document.querySelector('input[type=url]').value")).toBe("https://private-draft.invalid/mcp");
    expect(await page.evaluate("document.querySelector('input[type=password]').value")).toBe("PRIVATE-CREDENTIAL-DRAFT");
    page.acceptDialogs(true);
    await page.evaluate("history.back()");
    await page.until("location.pathname + location.search === " + JSON.stringify(cap()) + " && document.querySelector('[data-cap-name=catalog]') !== null");
    await page.evaluate("history.back()");
    await page.until("location.search === '?tab=settings' && document.querySelector('#poll-interval') !== null");
    await page.evaluate("history.forward()");
    await page.until("location.pathname + location.search === " + JSON.stringify(cap()) + " && document.querySelector('[data-cap-name=catalog]') !== null");
    await page.evaluate("history.forward()");
    await page.until("document.querySelector('input[type=url]') !== null");
    expect(await page.path()).toBe(cap("server", "catalog"));
    expect(await page.evaluate("document.querySelector('input[type=url]').value")).toBe("https://catalog.invalid/mcp");
    expect(await page.evaluate("document.querySelector('input[type=password]').value")).toBe("");
    expect(f.calls).toEqual([]); expect(page.writes).toEqual([]); expect(page.errors).toEqual([]);
  }, 45_000);

  it("preserves a copied destination through unlock and rejected authentication without exposing credentials in the URL", async () => {
    const f = await fixture();
    const query = new URLSearchParams({ open: f.timeline[0].id + ":call-0", raw: f.timeline[3].id });
    const destination = "/agents/alpha?" + query;
    const page = await browser(f.base + destination, cleanup);
    await page.until("document.body.innerText.includes('Unlock the console')");
    expect(await page.path()).toBe(destination);
    await page.evaluate("navTest.input('Console token', " + JSON.stringify("b".repeat(64)) + "); document.querySelector('.unlock form').requestSubmit()");
    await page.until("sessionStorage.getItem('token') === null && document.body.innerText.includes('Unlock the console')");
    expect(await page.path()).toBe(destination);
    await page.evaluate("navTest.input('Console token', " + JSON.stringify(token) + "); document.querySelector('.unlock form').requestSubmit()");
    await page.until("document.querySelector('article.turn[data-i=\"0\"] .calls') !== null && document.querySelector('article.turn[data-i=\"3\"] > .head[aria-expanded=true]') !== null");
    expect(await page.path()).toBe(destination);
    expect(await page.evaluate("location.href.includes(" + JSON.stringify(token) + ")")).toBe(false);
    await page.reload();
    await page.until("document.querySelector('article.turn[data-i=\"0\"] .calls') !== null");
    expect(await page.path()).toBe(destination);
    expect(f.calls).toEqual([]); expect(page.writes).toEqual([]); expect(page.errors).toEqual([]);
  }, 45_000);

  it.each([
    ["unknown agent", "/agents/missing", "Agent unavailable"],
    ["missing call", "/agents/alpha?open=missing-call", "Destination unavailable"],
    ["missing event", "/agents/alpha?raw=missing-event", "Destination unavailable"],
    ["unknown page", "/agents/alpha?tab=missing", "Destination unavailable"],
    ["missing skill", cap("skill", "missing"), "Destination unavailable"],
    ["missing server", cap("server", "missing", 2), "Destination unavailable"],
    ["missing credential", cap("credential", "MISSING_TOKEN"), "Destination unavailable"],
    ["unsaved server step", cap("server", "", 2), "Destination unavailable"],
  ])("shows an explicit destination failure for %s without fallback or mutation", async (_name, destination, message) => {
    const f = await fixture();
    const page = await browser(f.base + destination + "#token=" + token, cleanup);
    await page.until("document.querySelector('select[aria-label=Agent]')?.options.length >= 2");
    await page.until("document.body.innerText.includes(" + JSON.stringify(message) + ")");
    expect(await page.path()).toBe(destination);
    expect(f.calls).toEqual([]); expect(page.writes).toEqual([]); expect(page.errors).toEqual([]);
  }, 40_000);
});
