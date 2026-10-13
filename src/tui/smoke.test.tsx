// The terminal UI against a throwaway host (test/fixtures/tui-host.mjs: temporary agent
// folders, real stores, scripted model, fake CLI). Run with `pnpm tui:test`.
import { afterAll, expect, test } from "bun:test";
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
  const { setup, until, keys, opened, quits } = await draw(130, 44);
  const timeline = await until((frame) => frame.includes("A new bid arrived"));
  expect(timeline).toContain("DEVELOPMENT · local TaskFast server · no real money");
  expect(timeline).toContain("Needs attention · 2");
  expect(timeline).toContain("UNCERTAIN accept:44444444-4444-4444-8444-444444444444");
  expect(timeline).toContain("DEAD-LETTERED event has no name");
  expect(timeline).toContain("[▸ 4 tool calls · 1 failed · 1 uncertain]");
  expect(timeline).toContain("Edit 12 product photos");
  expect(timeline).toContain("http://localhost:4000/tasks/11111111-1111-4111-8111-111111111111");
  expect(timeline).toContain("Ready to work? yes");

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
  await until((frame) => frame.includes("Message queued") && frame.includes("1 waiting"));
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
  await until((frame) => frame.includes("A new bid arrived"));
  other.host.kill("SIGTERM");
  const down = await until((frame) => frame.includes("Can't reach the console"));
  expect(down).not.toContain("A new bid arrived");
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
