import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PAGE } from "../src/console-page.js";
import { readCapabilityFolder } from "../src/console-capabilities-page.js";
import type { CapabilityView } from "../src/capability-types.js";

const text = "---\nname: research\ndescription: Read source material.\n---\n<img src=https://invalid.test/x onerror=alert(1)>\n";
const file = (path = "research/SKILL.md", content = text, size = Buffer.byteLength(content)) => ({
  name: path.split("/").at(-1)!, webkitRelativePath: path, size,
  arrayBuffer: async () => Uint8Array.from(Buffer.from(content)).buffer,
});

describe("skill directory validation", () => {
  it("preserves paths and inert source bytes", async () => {
    const result = await readCapabilityFolder([file(), file("research/reference/notes.txt", "plain text")]);
    expect(result).toEqual({ name: "research", description: "Read source material.", files: [{ path: "SKILL.md", text }, { path: "reference/notes.txt", text: "plain text" }] });
  });
  it.each([
    ["research/../SKILL.md", text, /unsafe/],
    ["research/.env", "credential", /unsafe/],
    ["research/a\\b.md", text, /unsafe/],
    ["research/a/b/c/d.md", text, /deeply nested/],
    ["research/run.sh", "exit 0", /only .md and .txt/],
    ["research/notes.txt", "notes", /SKILL.md: required/],
    ["other/SKILL.md", text, /name must match/],
    ["research/SKILL.md", "not metadata", /metadata/],
    ["research/SKILL.md", "---\nname: research\n---", /description/],
    ["SKILL.md", text, /browser did not supply a folder path/],
  ])("rejects %s with a file-specific reason", async (path, content, error) => {
    await expect(readCapabilityFolder([file(String(path), String(content))])).rejects.toThrow(error);
  });
  it("rejects duplicate paths, mixed folders, size limits and invalid UTF-8", async () => {
    await expect(readCapabilityFolder([file(), file()])).rejects.toThrow("duplicate path");
    await expect(readCapabilityFolder([file(), file("other/notes.txt")])).rejects.toThrow("one skill folder");
    await expect(readCapabilityFolder([file("research/SKILL.md", text, 256 * 1024 + 1)])).rejects.toThrow("256 KiB");
    await expect(readCapabilityFolder(Array.from({ length: 65 }, () => file()))).rejects.toThrow("1–64");
    await expect(readCapabilityFolder([{ ...file(), arrayBuffer: async () => new Uint8Array([255]).buffer }])).rejects.toThrow("UTF-8");
  });
});

// Optional real-browser coverage without a browser-test dependency in the host package.
// TASKFAST_BROWSER=/path/to/chromium pnpm exec vitest run test/console-capabilities-page.test.ts
const browserPath = process.env.TASKFAST_BROWSER;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function browser(url: string, ready = "document.querySelector('nav') !== null") {
  const profile = mkdtempSync(join(tmpdir(), "taskfast-capabilities-browser-"));
  const process = spawn(browserPath!, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  cleanup.push(async () => { process.kill("SIGTERM"); await new Promise<void>((resolve) => { if (process.exitCode !== null) resolve(); else process.once("exit", () => resolve()); }); rmSync(profile, { recursive: true, force: true }); });
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Chromium did not expose DevTools: " + output.slice(-1000))), 20_000);
    process.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output); if (match) { clearTimeout(timeout); resolve("http://127.0.0.1:" + match[1]); } });
    process.once("error", reject);
  });
  const page: unknown = await (await fetch(endpoint + "/json/new?" + encodeURIComponent(url), { method: "PUT" })).json();
  if (!page || typeof page !== "object" || !("webSocketDebuggerUrl" in page) || typeof page.webSocketDebuggerUrl !== "string") throw new Error("No page DevTools endpoint");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("DevTools socket failed")); });
  cleanup.push(async () => { socket.close(); });
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  socket.onmessage = (event) => {
    const packet: unknown = JSON.parse(String(event.data));
    if (!packet || typeof packet !== "object" || !("id" in packet) || typeof packet.id !== "number") return;
    const pending = waiting.get(packet.id); if (!pending) return; waiting.delete(packet.id);
    if ("error" in packet) pending.reject(new Error(JSON.stringify(packet.error))); else pending.resolve("result" in packet ? packet.result : undefined);
  };
  async function protocol(method: string, params: Record<string, unknown>) {
    const id = ++nextId;
    const response = new Promise<unknown>((resolve, reject) => waiting.set(id, { resolve, reject }));
    socket.send(JSON.stringify({ id, method, params }));
    return response;
  }
  async function evaluate(expression: string): Promise<unknown> {
    const result = await protocol("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (!result || typeof result !== "object") throw new Error("No evaluation result");
    if ("exceptionDetails" in result) throw new Error(JSON.stringify(result.exceptionDetails));
    if (!("result" in result) || !result.result || typeof result.result !== "object") return undefined;
    return "value" in result.result ? result.result.value : undefined;
  }
  async function until(expression: string) {
    for (let index = 0; index < 100; index++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Browser condition failed: " + expression + "\n" + String(await evaluate("document.body.innerText")));
  }
  await until(ready);
  return { evaluate, until, protocol };
}

async function tokenConsole() {
  let token = 'a'.repeat(64);
  const requests: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(PAGE); return; }
    if (req.url !== '/api/agents') { res.writeHead(404); res.end(); return; }
    requests.push(req.headers.authorization);
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    res.end(JSON.stringify({ env: 'local', agents: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No HTTP address');
  return { url: 'http://127.0.0.1:' + address.port + '/', requests, replaceToken(next: string) { token = next; } };
}

async function captureTokenPage(page: Awaited<ReturnType<typeof browser>>, name: string) {
  const directory = process.env.TASKFAST_TOKEN_CAPTURE_DIR;
  if (!directory) return;
  const result = await page.protocol('Page.captureScreenshot', { format: 'png' });
  if (!result || typeof result !== 'object' || !('data' in result) || typeof result.data !== 'string') throw new Error('No screenshot data');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name + '.png'), Buffer.from(result.data, 'base64'));
}

it.skipIf(!browserPath).each(['cold', 'already-open', 'replacement', 'refused'])("authenticates %s token links in Chromium", async (kind) => {
  const fixture = await tokenConsole();
  const first = 'a'.repeat(64), second = 'b'.repeat(64);
  const unlock = "document.querySelector('input[type=password]') !== null";
  const page = kind === 'already-open'
    ? await browser(fixture.url, unlock)
    : kind === 'refused'
      ? await browser(fixture.url + '#token=' + second, unlock)
      : await browser(fixture.url + '#token=' + first);
  if (kind === 'already-open') {
    expect(await page.evaluate("sessionStorage.getItem('token')")).toBeNull();
    expect(fixture.requests).toEqual([]);
  } else if (kind === 'refused') {
    expect(fixture.requests).toContain('Bearer ' + second);
    expect(await page.evaluate("sessionStorage.getItem('token')")).toBeNull();
    expect(await page.evaluate('location.hash')).toBe('');
  } else {
    await expect.poll(() => fixture.requests).toContain('Bearer ' + first);
    expect(await page.evaluate("sessionStorage.getItem('token')")).toBe(first);
    expect(await page.evaluate('location.hash')).toBe('');
  }
  const expected = kind === 'replacement' ? second : first;
  if (kind === 'replacement') fixture.replaceToken(second);
  if (kind !== 'cold') await page.protocol('Page.navigate', { url: fixture.url + '#token=' + expected });
  try {
    await page.until("sessionStorage.getItem('token') === " + JSON.stringify(expected) + " && location.hash === '' && document.querySelector('nav') !== null && document.querySelector('input[type=password]') === null");
  } catch (error) {
    if (kind === 'already-open') await captureTokenPage(page, 'token-link-before');
    throw error;
  }
  await expect.poll(() => fixture.requests).toContain('Bearer ' + expected);
  expect(await page.evaluate("sessionStorage.getItem('token')")).toBe(expected);
  expect(await page.evaluate('location.hash')).toBe('');
  expect(await page.evaluate("document.querySelector('input[type=password]')")).toBeNull();
  if (kind === 'already-open') await captureTokenPage(page, 'token-link-after');
}, 30_000);

it.skipIf(!browserPath)("ignores invalid token fragments on an already-open Chromium unlock page", async () => {
  const fixture = await tokenConsole();
  const page = await browser(fixture.url, "document.querySelector('input[type=password]') !== null");
  await page.evaluate("window.originalDocument = document; window.hashChanges = 0; addEventListener('hashchange', () => { window.hashChanges++; });");
  const hashes = ['#timeline', '#token=bad', '#token=' + 'A'.repeat(64), '#token=' + 'a'.repeat(64) + '&extra=1'];
  for (const [index, hash] of hashes.entries()) {
    await page.protocol('Page.navigate', { url: fixture.url + hash });
    await page.until('window.hashChanges === ' + (index + 1));
    expect(await page.evaluate('document === window.originalDocument')).toBe(true);
    expect(await page.evaluate('location.hash')).toBe(hash);
    expect(await page.evaluate("sessionStorage.getItem('token')")).toBeNull();
    expect(await page.evaluate("document.querySelector('input[type=password]') !== null")).toBe(true);
  }
  expect(fixture.requests).toEqual([]);
}, 30_000);

const initial = (id: string): CapabilityView => ({ agentDir: "/fixture/agents/" + id, revision: "rev-1", activeRevision: "rev-1", skills: [], servers: [], credentials: [], activeSkills: [], activeServers: [], credentialChanges: [], pending: false, apply: { state: "idle" } });

it.skipIf(!browserPath)("exercises real browser consent, read approvals, apply status, stale edits and agent isolation", async () => {
  const requests: { agent: string; action: string; body: Record<string, unknown> }[] = [];
  const views: Record<string, CapabilityView> = { alpha: initial("alpha"), beta: initial("beta") };
  let rejectSave = false, holdTest = false;
  let releaseTest: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end(PAGE); return; }
    if (req.url === "/api/agents") { res.end(JSON.stringify({ env: "local", agents: [{ id: "alpha", name: "Alpha", state: "stopped", generation: 1 }, { id: "beta", name: "Beta", state: "stopped", generation: 1 }] })); return; }
    const route = /^\/api\/agents\/(alpha|beta)\/capabilities(?:\/([a-z-]+))?$/.exec(req.url || "");
    if (!route) { res.writeHead(404); res.end("{}"); return; }
    const id = route[1]!, action = route[2] || "", view = views[id]!;
    if (req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += String(chunk);
      const body: Record<string, unknown> = JSON.parse(raw);
      requests.push({ agent: id, action, body });
      if (body.revision !== view.revision || (action === "server" && rejectSave)) { res.writeHead(409); res.end(JSON.stringify({ error: "stale" })); return; }
      if (action === "test") view.test = { testId: "test-alpha", name: String(body.name), tools: [
        { name: "search", description: "<img src=x> Read source records.", inputSchema: { type: "object", properties: { q: { type: "string" } } }, hash: "read-hash", blocked: false, annotations: { readOnlyHint: true } },
        { name: "delete", description: "Delete a record.", inputSchema: { type: "object" }, hash: "write-hash", blocked: true },
      ] };
      if (action === "test" && holdTest) await new Promise<void>((resolve) => { releaseTest = resolve; });
      if (action === "stage-skill") { view.skills = [{ name: "research", description: "Read source material.", enabled: body.enabled === true, files: [{ path: "SKILL.md", text }] }]; view.pending = true; view.revision = "rev-import"; }
      if (action === "server") { view.pending = true; view.revision = "rev-2"; }
      if (action === "apply") view.apply = { state: "waiting", requestId: String(body.requestId) };
      if (action === "cancel") view.apply = { state: "cancelled", requestId: String(body.requestId) };
    }
    res.end(JSON.stringify(view));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No HTTP address");
  const page = await browser("http://127.0.0.1:" + address.port + "/#token=" + "a".repeat(64));
  // All controls are operated through the shipped page, not a success-shaped fixture.
  await page.evaluate(`window.click = text => { const node = [...document.querySelectorAll('button,a')].find(node => node.textContent === text); if (!node) throw Error('Missing: '+text); node.click(); }; window.input = (label,value) => { const input = [...document.querySelectorAll('label')].find(node => node.firstChild.textContent === label)?.querySelector('input'); if (!input) throw Error('Missing field: '+label); input.value = value; input.dispatchEvent(new Event('input',{bubbles:true})); }; click('Capabilities');`);
  await page.until("document.body.innerText.includes('No skills installed')");
  expect(await page.evaluate("document.body.innerText.includes('Capabilities · Alpha')")).toBe(true);
  await page.evaluate("click('Add MCP server'); input('Server name','sources'); input('Remote URL','https://sources.invalid/mcp'); click('Add credential binding'); input('HTTP header','Authorization'); input('Private binding name','SOURCE_TOKEN'); input('New credential value','synthetic-private-value'); click('Continue to test and review tools');");
  expect(await page.evaluate("[...document.querySelectorAll('button')].find(n=>n.textContent==='Test connection').disabled")).toBe(true);
  expect(requests.filter((entry) => entry.action === "test")).toHaveLength(0);
  expect(await page.evaluate("document.body.innerText.includes('synthetic-private-value')")).toBe(false);
  expect(await page.evaluate("[...Object.values(sessionStorage),...Object.values(localStorage)].some(value=>value.includes('synthetic-private-value'))")).toBe(false);
  await page.evaluate("document.querySelector('.cap-check input').click(); click('Test connection');");
  await page.until("document.body.innerText.includes('Test passed; not active')");
  expect(await page.evaluate("document.querySelector('img') === null")).toBe(true);
  expect(await page.evaluate("[...document.querySelectorAll('fieldset .cap-check input')].every(input=>!input.checked)")).toBe(true);
  expect(await page.evaluate("document.body.innerText.includes('Unavailable: known write or unsafe tool')")).toBe(true);
  await page.evaluate("document.querySelector('fieldset .cap-check input').click(); click('Continue to review and save');");
  expect(await page.evaluate("[...document.querySelectorAll('button')].find(n=>n.textContent==='Save and enable after apply').disabled")).toBe(false);
  await page.evaluate("click('Save and enable after apply');");
  await page.until("document.body.innerText.includes('Pending changes. The active configuration')");
  const saved = requests.find((entry) => entry.action === "server")!;
  expect(saved.agent).toBe("alpha");
  expect(saved.body).toMatchObject({ revision: "rev-1", testId: "test-alpha", approved: [{ name: "search", hash: "read-hash", read: true }], secrets: { SOURCE_TOKEN: "synthetic-private-value" } });
  await page.evaluate("click('Review changes');");
  expect(await page.evaluate("[...document.querySelectorAll('button')].find(n=>n.textContent==='Apply when idle').disabled")).toBe(true);
  await page.evaluate("document.querySelector('.cap-detail .cap-check input').click(); click('Apply when idle');");
  await page.until("document.body.innerText.includes('Waiting for idle.')");
  expect(requests.find((entry) => entry.action === "apply")!.body.revision).toBe("rev-2");
  await page.evaluate("click('Cancel waiting apply');");
  await page.until("document.body.innerText.includes('Apply cancelled.')");
  // An apply poll must not rebuild a focused connection form or its selection.
  await page.evaluate("click('Back to capabilities'); click('Add MCP server'); input('Server name','unsaved'); input('Remote URL','https://changed.invalid'); window.focused = [...document.querySelectorAll('input')].find(n=>n.value==='unsaved'); focused.focus(); focused.setSelectionRange(1,4);");
  views.alpha!.apply = { state: "failed", requestId: "other", error: "Reopen refused. Actual active revision retained." };
  await page.until("document.body.innerText.includes('Apply failed.')");
  expect(await page.evaluate("document.activeElement===focused && focused.selectionStart===1 && focused.selectionEnd===4")).toBe(true);
  // Switching agents discards credentials and tests only after explicit navigation confirmation.
  await page.evaluate("window.confirm=()=>true; const selector=document.querySelector('select[aria-label=Agent]'); selector.value='beta'; selector.dispatchEvent(new Event('change',{bubbles:true}));");
  await page.until("document.body.innerText.includes('Capabilities · Beta')");
  expect(await page.evaluate("document.body.innerText.includes('unsaved')")).toBe(false);
  await page.evaluate("click('Add MCP server'); input('Server name','beta-server'); input('Remote URL','https://beta.invalid'); click('Continue to test and review tools'); click('Continue to review and save');");
  expect(await page.evaluate("[...document.querySelectorAll('button')].find(n=>n.textContent==='Save and enable after apply').disabled")).toBe(true);
  // A stale rejection must keep nonsecret fields, never claim that the save worked.
  rejectSave = true;
  await page.evaluate("click('Save disabled');");
  await page.until("document.body.innerText.includes('Configuration changed.')");
  expect(await page.evaluate("document.body.innerText.includes('Review and save')")).toBe(true);
  expect(requests.at(-1)?.agent).toBe("beta");
  // A late discovery result must not populate a different agent or a new editor session.
  rejectSave = false; holdTest = true;
  await page.evaluate("click('Back to capabilities'); click('Add MCP server'); input('Server name','beta-late'); input('Remote URL','https://beta.invalid/mcp'); click('Continue to test and review tools'); document.querySelector('.cap-check input').click(); click('Test connection');");
  await page.until("document.body.innerText.includes('Testing connection and discovering tools')");
  await page.evaluate("{ const selector=document.querySelector('select[aria-label=Agent]'); selector.value='alpha'; selector.dispatchEvent(new Event('change',{bubbles:true})); }");
  await page.until("document.body.innerText.includes('Capabilities · Alpha')");
  expect(requests.filter((entry) => entry.action === "test").at(-1)?.agent).toBe("beta");
  releaseTest?.();
  await page.evaluate("click('Import folder'); const transfer=new DataTransfer(); const file=new File([" + JSON.stringify(text) + "],'SKILL.md',{type:'text/plain'}); Object.defineProperty(file,'webkitRelativePath',{value:'research/SKILL.md'}); transfer.items.add(file); const picker=document.querySelector('input[type=file]'); picker.files=transfer.files; picker.dispatchEvent(new Event('change',{bubbles:true}));");
  await page.until("document.body.innerText.includes('Folder validated locally.')");
  expect(await page.evaluate("document.querySelector('img')===null")).toBe(true);
  await page.evaluate("{ const transfer=new DataTransfer();const bad=new File(['not metadata'],'SKILL.md');Object.defineProperty(bad,'webkitRelativePath',{value:'research/SKILL.md'});transfer.items.add(bad);const picker=document.querySelector('input[type=file]');picker.files=transfer.files;picker.dispatchEvent(new Event('change',{bubbles:true})); }");
  await page.until("document.body.innerText.includes('must start with --- metadata')");
  expect(await page.evaluate("[...document.querySelectorAll('button')].some(node=>node.textContent==='Stage imported skill')")).toBe(false);
  await page.evaluate("{ const transfer=new DataTransfer();const corrected=new File([" + JSON.stringify(text) + "],'SKILL.md');Object.defineProperty(corrected,'webkitRelativePath',{value:'research/SKILL.md'});transfer.items.add(corrected);const picker=document.querySelector('input[type=file]');picker.files=transfer.files;picker.dispatchEvent(new Event('change',{bubbles:true})); }");
  await page.until("document.body.innerText.includes('Folder validated locally.')");
  await page.evaluate("click('Stage imported skill');");
  await page.until("document.querySelector('[data-cap-name=research]')!==null");
  expect(requests.filter((entry) => entry.action === "stage-skill").at(-1)).toMatchObject({ agent: "alpha", body: { files: [{ path: "research/SKILL.md", text }], replace: false, enabled: true } });
  await page.protocol("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  expect(await page.evaluate("document.documentElement.scrollWidth<=window.innerWidth")).toBe(true);
  expect(await page.evaluate("getComputedStyle(document.querySelector('.cap-columns')).gridTemplateColumns.split(' ').length")).toBe(1);
  await page.evaluate("click('Inspect');");
  expect(await page.evaluate("document.querySelector('.cap-detail')!==null && document.querySelector('dialog')===null")).toBe(true);
  await page.evaluate("click('Back to capabilities'); click('Add MCP server'); input('Server name','local-sources'); const type=document.querySelector('.cap-detail select'); type.value='local'; type.dispatchEvent(new Event('change',{bubbles:true})); input('Installed executable (absolute path)','/usr/bin/fixture-reader'); click('Add argument'); input('Argument 1','--source'); click('Add argument'); input('Argument 2','notes with spaces'); input('Working directory (relative to this agent folder)','references'); click('Continue to test and review tools');");
  expect(await page.evaluate("document.body.innerText.includes('/usr/bin/fixture-reader') && document.body.innerText.includes('notes with spaces') && document.body.innerText.includes('/fixture/agents/alpha/references')")).toBe(true);
  expect(await page.evaluate("[...document.querySelectorAll('button')].find(n=>n.textContent==='Test connection').disabled")).toBe(true);
  expect(await page.evaluate("document.documentElement.scrollWidth<=window.innerWidth")).toBe(true);
  // Real revisions are SHA-256 tokens, not the short fixture labels above.
  views.alpha!.activeRevision = "a".repeat(64); views.alpha!.revision = "b".repeat(64);
  await page.until("document.querySelector('.cap-pending').textContent.includes('a'.repeat(64))");
  expect(await page.evaluate("document.documentElement.scrollWidth<=window.innerWidth")).toBe(true);
}, 60_000);

it.skipIf(!browserPath)("previews exact CLI bundles, reviews item and credential deltas, discards individual changes and disables without testing", async () => {
  const taskfast = { name: "taskfast-agent", description: "TaskFast marketplace guidance.", enabled: true, files: [{ path: "SKILL.md", text: "---\nname: taskfast-agent\ndescription: TaskFast marketplace guidance.\n---\nNew CLI text <img src=https://invalid.test/image>" }], provenance: { source: "taskfast-cli", version: "0.23.0", files: { "SKILL.md": "new-file-hash" } } };
  const ownerCopy = { ...structuredClone(taskfast), enabled: false, files: [{ path: "SKILL.md", text: "Owner-edited CLI instructions" }], modifiedFiles: ["SKILL.md"], provenance: { ...taskfast.provenance, version: "0.22.0" } };
  const removedSkill = { name: "research", description: "Read source material.", enabled: true, files: [{ path: "SKILL.md", text }] };
  const oldServer = { name: "catalog", config: { url: "https://catalog.invalid/mcp", headers: { Authorization: "OLD_TOKEN" } }, enabled: true, credentials: ["OLD_TOKEN"], approved: [{ name: "read", hash: "old-read-hash" }, { name: "gone", hash: "removed-tool-hash" }] };
  const nextServer = { ...structuredClone(oldServer), config: { url: "https://catalog.invalid/mcp", headers: { Authorization: "ROTATE_TOKEN" } }, credentials: ["ROTATE_TOKEN"], approved: [{ name: "read", hash: "new-read-hash" }, { name: "new", hash: "added-tool-hash" }] };
  const views: Record<string, CapabilityView> = { alpha: initial("alpha"), beta: { ...initial("beta"), pending: true, activeSkills: [ownerCopy, removedSkill], skills: [structuredClone(ownerCopy)], activeServers: [oldServer], servers: [nextServer], credentials: ["NEW_TOKEN", "ROTATE_TOKEN"], credentialChanges: [{ name: "NEW_TOKEN", change: "added" }, { name: "ROTATE_TOKEN", change: "replaced" }, { name: "OLD_TOKEN", change: "removed" }], connections: [{ name: "catalog", state: "connected" }] } };
  const requests: { agent: string; action: string; body: Record<string, unknown> }[] = [];
  let serial = 0, rejectImport = false;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end(PAGE); return; }
    if (req.url === "/api/agents") { res.end(JSON.stringify({ env: "local", agents: [{ id: "alpha", name: "Alpha", state: "stopped", generation: 1 }, { id: "beta", name: "Beta", state: "stopped", generation: 1 }] })); return; }
    const route = /^\/api\/agents\/(alpha|beta)\/capabilities(?:\/([a-z-]+))?$/.exec(req.url || "");
    if (!route) { res.writeHead(404); res.end("{}"); return; }
    const id = route[1]!, action = route[2] || "", view = views[id]!;
    if (req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += String(chunk);
      const body: Record<string, unknown> = JSON.parse(raw);
      requests.push({ agent: id, action, body });
      if (body.revision !== view.revision) { res.writeHead(409); res.end(JSON.stringify({ error: "Review the current public revision" })); return; }
      if (action === "preview-taskfast") view.skillPreview = { previewId: "preview-" + id + "-" + serial, skill: structuredClone(taskfast) };
      else if (action === "taskfast-skill") {
        const preview = view.skillPreview;
        if (!preview || body.previewId !== preview.previewId || body.replace !== view.skills.some((skill) => skill.name === "taskfast-agent")) { res.writeHead(400); res.end(JSON.stringify({ error: "Explicit replacement of the exact preview is required" })); return; }
        view.skills = [...view.skills.filter((skill) => skill.name !== "taskfast-agent"), { ...structuredClone(preview.skill), enabled: body.enabled === true }];
        view.pending = true; view.revision = "staged-" + ++serial;
      } else if (action === "discard-item") {
        const name = String(body.name);
        if (body.kind === "server" && view.credentialChanges.some((item) => item.name === "OLD_TOKEN" && item.change === "removed")) { res.writeHead(400); res.end(JSON.stringify({ error: "catalog: restore credential OLD_TOKEN before discarding this connection change" })); return; }
        if (body.kind === "skill") view.skills = [...view.skills.filter((skill) => skill.name !== name), ...view.activeSkills.filter((skill) => skill.name === name).map((skill) => structuredClone(skill))];
        if (body.kind === "server") view.servers = view.activeServers.map((entry) => structuredClone(entry));
        if (body.kind === "credential") { view.credentialChanges = view.credentialChanges.filter((item) => item.name !== name); if (name === "OLD_TOKEN") view.credentials.push(name); }
        view.revision = "discarded-" + ++serial;
        view.pending = id === "beta" || !!view.skills.length;
      } else if (action === "server") {
        if (body.enabled !== false || body.testId !== undefined) { res.writeHead(400); res.end(JSON.stringify({ error: "Only the untested disable path is expected in this fixture" })); return; }
        view.servers = view.servers.map((entry) => entry.name === body.name ? { ...entry, enabled: false, approved: [] } : entry);
        view.revision = "disabled-" + ++serial;
      } else if (action === "stage-skill" && rejectImport) { res.writeHead(400); res.end(JSON.stringify({ error: "research/reference/notes.txt: destination path is unsafe" })); return; }
      else { res.writeHead(400); res.end(JSON.stringify({ error: "Unexpected fixture operation" })); return; }
    }
    res.end(JSON.stringify(view));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No HTTP address");
  const page = await browser("http://127.0.0.1:" + address.port + "/#token=" + "b".repeat(64));
  await page.evaluate(`window.confirm=()=>true; window.click = text => { const node = [...document.querySelectorAll('button,a')].find(node=>node.textContent===text); if(!node)throw Error('Missing: '+text); node.click(); }; window.byLabel = name => { const node=[...document.querySelectorAll('button')].find(node=>node.getAttribute('aria-label')===name); if(!node)throw Error('Missing label: '+name); node.click(); }; window.switchAgent=id=>{const selector=document.querySelector('select[aria-label=Agent]');selector.value=id;selector.dispatchEvent(new Event('change',{bubbles:true}));}; click('Capabilities');`);
  await page.until("document.body.innerText.includes('No skills installed')");
  await page.evaluate("click('Add TaskFast skill');");
  await page.until("document.body.innerText.includes('Preview ready.')");
  expect(views.alpha!.pending).toBe(false);
  expect(requests.filter((entry) => entry.action === "taskfast-skill")).toHaveLength(0);
  expect(await page.evaluate("document.body.innerText.includes('0.23.0') && document.querySelector('img')===null")).toBe(true);
  const firstPreview = views.alpha!.skillPreview!.previewId;
  await page.evaluate("click('Add and enable after apply');");
  await page.until("document.querySelector('[data-cap-name=taskfast-agent]')!==null");
  expect(requests.find((entry) => entry.action === "taskfast-skill")!.body).toEqual({ revision: "rev-1", previewId: firstPreview, replace: false, enabled: true });
  await page.evaluate("click('Review changes'); byLabel('Discard skill change taskfast-agent');");
  await page.until("document.body.innerText.includes('No skills before or after apply.')");
  expect(requests.at(-1)).toMatchObject({ agent: "alpha", action: "discard-item", body: { kind: "skill", name: "taskfast-agent", revision: "staged-1" } });
  await page.evaluate("click('Back to capabilities'); click('Add TaskFast skill');");
  await page.until("document.body.innerText.includes('Preview ready.')");
  await page.evaluate("click('Add disabled');");
  await page.until("document.querySelector('[data-cap-name=taskfast-agent]')!==null");
  expect(requests.filter((entry) => entry.action === "taskfast-skill").at(-1)!.body.enabled).toBe(false);
  await page.evaluate("switchAgent('beta');");
  await page.until("document.body.innerText.includes('Capabilities · Beta') && document.querySelector('[data-cap-name=catalog]')!==null");
  expect(await page.evaluate("document.querySelector('.cap-health').textContent")).toBe("Connection: Connected");
  views.beta!.connections = [{ name: "catalog", state: "disconnected" }];
  await page.until("document.querySelector('.cap-health').textContent==='Connection: Disconnected'");
  expect(await page.evaluate("document.querySelector('[data-cap-name=catalog]').innerText.includes('2 approved tools') && document.querySelector('[data-cap-name=catalog]').innerText.includes('No result in this host session')")).toBe(true);
  await page.evaluate("click('Review TaskFast replacement');");
  await page.until("document.body.innerText.includes('Preview ready.')");
  expect(await page.evaluate("document.body.innerText.includes('Owner edits detected: SKILL.md') && document.body.innerText.includes('0.22.0') && document.body.innerText.includes('0.23.0')")).toBe(true);
  expect(await page.evaluate("[...document.querySelectorAll('button')].find(node=>node.textContent==='Stage explicit replacement').disabled")).toBe(true);
  expect(await page.evaluate("[...document.querySelectorAll('.cap-check')].find(node=>node.innerText.includes('Enable after apply')).querySelector('input').checked")).toBe(false);
  await page.evaluate("document.querySelector('.cap-check input').click(); click('Stage explicit replacement');");
  await page.until("document.querySelector('[data-cap-name=taskfast-agent]')!==null");
  expect(requests.filter((entry) => entry.action === "taskfast-skill").at(-1)).toMatchObject({ agent: "beta", body: { previewId: "preview-beta-3", replace: true, enabled: false, revision: "rev-1" } });
  await page.evaluate("click('Review changes');");
  expect(await page.evaluate("document.querySelector('[data-review-name=research]').innerText.includes('Removed')")).toBe(true);
  expect(await page.evaluate("document.querySelector('[data-review-name=catalog]').innerText.includes('old-read-hash') && document.querySelector('[data-review-name=catalog]').innerText.includes('new-read-hash') && document.querySelector('[data-review-name=catalog]').innerText.includes('removed-tool-hash') && document.querySelector('[data-review-name=catalog]').innerText.includes('added-tool-hash')")).toBe(true);
  expect(await page.evaluate("document.querySelector('[data-review-name=NEW_TOKEN]').innerText.includes('Added') && document.querySelector('[data-review-name=ROTATE_TOKEN]').innerText.includes('Replaced') && document.querySelector('[data-review-name=OLD_TOKEN]').innerText.includes('Removed')")).toBe(true);
  await page.evaluate("byLabel('Discard server change catalog');");
  await page.until("document.body.innerText.includes('restore credential OLD_TOKEN before discarding')");
  expect(views.beta!.servers[0]!.config).toEqual(nextServer.config);
  await page.evaluate("byLabel('Edit credential NEW_TOKEN');");
  expect(await page.evaluate("document.body.innerText.includes('replace or use it, add a named credential binding on a server')")).toBe(true);
  await page.evaluate("click('Back to capabilities'); click('Review changes'); byLabel('Discard credential change OLD_TOKEN');");
  await page.until("document.querySelector('[data-review-name=OLD_TOKEN]')===null");
  await page.evaluate("byLabel('Discard server change catalog');");
  await page.until("document.querySelector('[data-review-name=catalog]').innerText.includes('old-read-hash') && !document.querySelector('[data-review-name=catalog]').innerText.includes('new-read-hash')");
  await page.evaluate("byLabel('Discard skill change research');");
  await page.until("document.querySelector('[data-review-name=research]').innerText.includes('Enabled → After apply: Enabled')");
  await page.evaluate("byLabel('Edit server catalog'); click('Stage disable without editing');");
  await page.until("document.querySelector('[data-cap-name=catalog]')!==null");
  const disabled = requests.filter((entry) => entry.action === "server").at(-1)!;
  expect(disabled.body).toMatchObject({ name: "catalog", enabled: false, approved: [], secrets: {} });
  expect(disabled.body).not.toHaveProperty("testId");
  expect(requests.filter((entry) => entry.action === "test")).toHaveLength(0);
  rejectImport = true;
  await page.evaluate("click('Import folder'); const upload=new DataTransfer();const imported=new File([" + JSON.stringify(text) + "],'SKILL.md');Object.defineProperty(imported,'webkitRelativePath',{value:'research/SKILL.md'});upload.items.add(imported);const picker=document.querySelector('input[type=file]');picker.files=upload.files;picker.dispatchEvent(new Event('change',{bubbles:true}));");
  await page.until("document.body.innerText.includes('Folder validated locally.')");
  // This name already exists after discarding its removal, so replacement must be explicit.
  await page.evaluate("document.querySelector('.cap-check input').click(); click('Stage explicit replacement');");
  await page.until("document.body.innerText.includes('research/reference/notes.txt: destination path is unsafe')");
  expect(await page.evaluate("document.querySelector('input[type=file]').getAttribute('aria-invalid')==='true' && document.querySelector('input[type=file]').getAttribute('aria-describedby')==='capability-field-error'")).toBe(true);
}, 60_000);

it.skipIf(!browserPath)("keeps stopped-agent removals reviewable after reload and restores individual saved items without claiming activation", async () => {
  const savedSkill = { name: "research", description: "Read source material.", enabled: true, files: [{ path: "SKILL.md", text }] };
  const savedServer = { name: "archive", config: { url: "https://archive.invalid/mcp" }, enabled: true, credentials: [], approved: [{ name: "lookup", hash: "saved-lookup-hash" }] };
  const view: CapabilityView = { ...initial("stopped"), activeRevision: null, savedSkills: [savedSkill], savedServers: [savedServer], skills: [structuredClone(savedSkill)], servers: [structuredClone(savedServer)] };
  const requests: { action: string; body: Record<string, unknown> }[] = [];
  let revision = 1;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end(PAGE); return; }
    if (req.url === "/api/agents") { res.end(JSON.stringify({ env: "local", agents: [{ id: "stopped", name: "Stopped agent", state: "stopped", generation: 1 }] })); return; }
    const route = /^\/api\/agents\/stopped\/capabilities(?:\/([a-z-]+))?$/.exec(req.url || "");
    if (!route) { res.writeHead(404); res.end("{}"); return; }
    if (req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += String(chunk);
      const body: Record<string, unknown> = JSON.parse(raw), action = route[1] || "";
      requests.push({ action, body });
      if (body.revision !== view.revision) { res.writeHead(409); res.end(JSON.stringify({ error: "Review the current revision" })); return; }
      if (action === "skill" && body.operation === "remove") view.skills = [];
      else if (action === "remove-server") view.servers = [];
      else if (action === "discard-item" && body.kind === "skill") view.skills = structuredClone(view.savedSkills!);
      else if (action === "discard-item" && body.kind === "server") view.servers = structuredClone(view.savedServers!);
      else { res.writeHead(400); res.end(JSON.stringify({ error: "Unexpected fixture operation" })); return; }
      view.revision = "rev-" + ++revision;
      view.pending = !view.skills.length || !view.servers.length;
    }
    res.end(JSON.stringify(view));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No HTTP address");
  const page = await browser("http://127.0.0.1:" + address.port + "/#token=" + "c".repeat(64));
  const helpers = `window.confirm=()=>true;window.click=text=>{const node=[...document.querySelectorAll('button,a')].find(node=>node.textContent===text);if(!node)throw Error('Missing: '+text);node.click();};window.byLabel=name=>{const node=[...document.querySelectorAll('button')].find(node=>node.getAttribute('aria-label')===name);if(!node)throw Error('Missing label: '+name);node.click();};`;
  await page.evaluate(helpers + "click('Capabilities');");
  await page.until("document.querySelector('[data-cap-name=research]')!==null");
  expect(await page.evaluate("document.querySelector('[data-cap-name=research]').innerText.includes('Active now: Not loaded') && document.querySelector('[data-cap-name=research]').innerText.includes('Saved on disk: Enabled')")).toBe(true);
  await page.evaluate("click('Inspect'); click('Stage removal');");
  await page.until("document.body.innerText.includes('Skill research: Saved on disk → Removed after apply')");
  await page.evaluate("click('Manage'); click('Stage server removal');");
  await page.until("document.body.innerText.includes('Server archive: Saved on disk → Removed after apply')");
  expect(view.activeSkills).toEqual([]); expect(view.activeServers).toEqual([]); expect(view.activeRevision).toBeNull();
  // Reload the real browser so no remembered UI baseline can manufacture the removal rows.
  await page.protocol("Page.reload", {});
  await page.until("document.querySelector('nav')!==null");
  await page.evaluate(helpers + "click('Capabilities');");
  await page.until("document.body.innerText.includes('Pending removal')");
  await page.evaluate("click('Review changes');");
  expect(await page.evaluate("document.querySelector('[data-review-name=research]').innerText.includes('Active now: Not loaded') && document.querySelector('[data-review-name=research]').innerText.includes('Saved on disk: Enabled → After apply: Removed')")).toBe(true);
  expect(await page.evaluate("document.querySelector('[data-review-name=archive]').innerText.includes('Saved hash: saved-lookup-hash') && document.querySelector('[data-review-name=archive]').innerText.includes('Runtime-active hash: none')")).toBe(true);
  await page.evaluate("byLabel('Edit skill research');");
  expect(await page.evaluate("document.body.innerText.includes('Removal staged.') && document.querySelector('.cap-preview').textContent.includes('name: research')")).toBe(true);
  await page.evaluate("click('Back to capabilities');click('Review changes');byLabel('Edit server archive');");
  expect(await page.evaluate("[...document.querySelectorAll('input')].some(node=>node.value==='https://archive.invalid/mcp') && document.body.innerText.includes('Connection: Not active')")).toBe(true);
  await page.evaluate("click('Back to capabilities');click('Review changes');byLabel('Discard skill change research');");
  await page.until("document.querySelector('[data-review-name=research]').innerText.includes('Saved on disk: Enabled → After apply: Enabled')");
  expect(await page.evaluate("document.querySelector('[aria-label=\"Discard skill change research\"]')===null && document.querySelector('[aria-label=\"Discard server change archive\"]')!==null")).toBe(true);
  await page.evaluate("click('Back to capabilities');click('Timeline');click('Capabilities');click('Review changes');byLabel('Discard server change archive');");
  await page.until("document.body.innerText.includes('No pending changes.')");
  expect(requests.filter((entry) => entry.action === "discard-item").map((entry) => entry.body)).toEqual([{ revision: "rev-3", kind: "skill", name: "research" }, { revision: "rev-4", kind: "server", name: "archive" }]);
  expect(await page.evaluate("document.querySelector('[data-review-name=archive]').innerText.includes('Active now: Not loaded') && document.querySelector('[data-review-name=archive]').innerText.includes('Saved hash: saved-lookup-hash') && document.querySelector('[data-review-name=archive]').innerText.includes('After apply hash: saved-lookup-hash')")).toBe(true);
  expect(view.activeRevision).toBeNull();
}, 60_000);
