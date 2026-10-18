import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

// Shared Chromium DevTools harness for the optional real-browser tests. No browser dependency.
// TASKFAST_BROWSER=/path/to/chromium pnpm exec vitest run test/console-navigation-browser.test.ts
export const browserPath = process.env.TASKFAST_BROWSER;

const browserHelpers = `window.navTest = {
  click(text) { const node = [...document.querySelectorAll('button,a')].find(node => node.textContent === text); if (!node) throw Error('Missing control: ' + text); node.click(); },
  input(label, value, event = 'input') { const node = [...document.querySelectorAll('label')].find(node => node.firstChild?.textContent === label)?.querySelector('input,textarea'); if (!node) throw Error('Missing field: ' + label); node.value = value; node.dispatchEvent(new Event(event, {bubbles:true})); },
  agent(id) { const node = document.querySelector('select[aria-label=Agent]'); if (!node) throw Error('Missing agent selector'); node.value = id; node.dispatchEvent(new Event('change', {bubbles:true})); }
};`;

/** Opens url in a fresh headless Chromium. Every process, socket and profile closes through cleanup. */
export async function browser(url: string, cleanup: (() => Promise<void>)[]) {
  if (!browserPath) throw new Error("TASKFAST_BROWSER is required");
  const profile = mkdtempSync(join(tmpdir(), "taskfast-browser-"));
  const child = spawn(browserPath, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(profile, { recursive: true, force: true });
  });
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Chromium did not expose DevTools: " + output.slice(-1000))), 20_000);
    const failed = (error: Error) => { clearTimeout(timeout); reject(error); };
    child.once("error", failed);
    child.once("exit", (code) => failed(new Error("Chromium exited (" + code + "): " + output.slice(-1000))));
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
      if (match) { clearTimeout(timeout); resolve("http://127.0.0.1:" + match[1]); }
    });
  });
  async function open(url: string) {
    const target: unknown = await (await fetch(endpoint + "/json/new?about:blank", { method: "PUT" })).json();
    if (!target || typeof target !== "object" || !("webSocketDebuggerUrl" in target) || typeof target.webSocketDebuggerUrl !== "string") throw new Error("No page DevTools endpoint");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("DevTools socket failed")); });
    const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    cleanup.push(async () => { for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error("Browser closed")); } waiting.clear(); socket.close(); });
    let nextId = 0, acceptDialogs = true, loads = 0;
    const dialogs: string[] = [], errors: unknown[] = [];
    const writes: unknown[] = [];
    socket.onmessage = (event) => {
      const packet: unknown = JSON.parse(String(event.data));
      if (!packet || typeof packet !== "object") return;
      if ("method" in packet && "params" in packet && packet.params && typeof packet.params === "object") {
        if (packet.method === "Page.loadEventFired") loads++;
        if (packet.method === "Page.javascriptDialogOpening") {
          dialogs.push("message" in packet.params ? String(packet.params.message) : "");
          void protocol("Page.handleJavaScriptDialog", { accept: acceptDialogs }).catch((error: unknown) => errors.push(error));
        }
        if (packet.method === "Runtime.exceptionThrown") errors.push(packet.params);
        if (packet.method === "Network.requestWillBeSent" && "request" in packet.params) {
          const request = packet.params.request;
          if (request && typeof request === "object" && "method" in request && ["POST", "PUT", "DELETE", "PATCH"].includes(String(request.method))) writes.push(request);
        }
      }
      if (!("id" in packet) || typeof packet.id !== "number") return;
      const pending = waiting.get(packet.id);
      if (!pending) return;
      waiting.delete(packet.id); clearTimeout(pending.timer);
      if ("error" in packet) pending.reject(new Error(JSON.stringify(packet.error)));
      else pending.resolve("result" in packet ? packet.result : undefined);
    };
    async function protocol(method: string, params: Record<string, unknown> = {}) {
      const id = ++nextId;
      const response = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error("DevTools timed out: " + method)); }, 15_000);
        waiting.set(id, { resolve, reject, timer });
      });
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
      for (let index = 0; index < 120; index++) {
        if (await evaluate(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Browser condition failed: " + expression + "\nURL: " + String(await evaluate("location.href")) + "\n" + String(await evaluate("document.body.innerText")));
    }
    const path = () => evaluate("location.pathname + location.search");
    async function go(url: string) {
      const before = loads, expected = new URL(url);
      if (/^#token=[0-9a-f]{64}$/.test(expected.hash)) expected.hash = "";
      await protocol("Page.navigate", { url });
      await expect.poll(() => loads).toBeGreaterThan(before);
      await until("document.readyState === 'complete' && location.href === " + JSON.stringify(expected.href));
    }
    async function reload() {
      const before = loads;
      await protocol("Page.reload");
      await expect.poll(() => loads).toBeGreaterThan(before);
    }
    async function push(action: string, expected: string) {
      const length = await evaluate("history.length");
      await evaluate(action);
      await until("location.pathname + location.search === " + JSON.stringify(expected));
      expect(await evaluate("history.length")).toBe(Number(length) + 1);
    }
    async function screenshot(name: string) {
      const dir = process.env.TASKFAST_NAV_EVIDENCE_DIR;
      if (!dir) return;
      const image = await protocol("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      if (!image || typeof image !== "object" || !("data" in image) || typeof image.data !== "string") throw new Error("No screenshot data");
      mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name + ".png"), Buffer.from(image.data, "base64"));
    }
    await protocol("Page.enable"); await protocol("Runtime.enable"); await protocol("Network.enable");
    await protocol("Page.addScriptToEvaluateOnNewDocument", { source: browserHelpers });
    await protocol("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await go(url);
    return { evaluate, until, protocol, path, push, go, reload, screenshot, dialogs, errors, writes, acceptDialogs: (value: boolean) => { acceptDialogs = value; } };
  }
  return { ...await open(url), open };
}
