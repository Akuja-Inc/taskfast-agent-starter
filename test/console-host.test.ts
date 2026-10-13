import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initialOperator } from "../src/core/operator.js";
import { runAgents, type AgentHandle, type RunOptions } from "../src/run.js";

const ROOT = join(import.meta.dirname, "..");
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });

// Agent folders with a valid agent file and an (empty) TaskFast config each.
function folders(...ids: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "console-host-"));
  dirs.push(dir);
  for (const id of ids) {
    mkdirSync(join(dir, id, ".taskfast"), { recursive: true });
    writeFileSync(join(dir, id, "agent.json"), readFileSync(join(ROOT, "examples", "brisk-poster.json")));
    writeFileSync(join(dir, id, ".taskfast", "config.json"), "{}");
  }
  return dir;
}
// A handle with the console's controls; records lifecycle calls by agent id.
function handle(id: string, calls: string[]): AgentHandle {
  return {
    deliver: async () => {},
    ping: async () => {},
    close: async () => void calls.push(`close ${id}`),
    status: async () => ({ identity: { env: "local", agentId: "33333333-3333-4333-8333-333333333333" }, actions: {}, spend: {}, memory: [] }),
    transcript: async () => [],
    operator: {
      state: async () => initialOperator(), events: async () => ({}),
      setFrozen: async () => {}, setPaused: async () => {}, message: async () => {}, addOrder: async () => {}, removeOrder: async () => {}, markChecked: async () => {}, retryEvent: async () => {},
    },
  };
}
// Runs the host until `body` finishes, then stops it.
async function host(options: Partial<RunOptions> & { agentsDir: string }, body: (link: URL | undefined, calls: string[]) => Promise<void>) {
  const stop = new AbortController();
  const lines: string[] = [];
  const calls: string[] = [];
  let ready = () => {};
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const running = runAgents({
    env: "local", signal: stop.signal, pingEveryMs: 60_000,
    openAgent: async ({ id }) => (calls.push(`open ${id}`), handle(id, calls)),
    listen: () => ({ close: async () => {} }),
    log: (line) => { lines.push(line); if (line.startsWith("running ")) ready(); },
    ...options,
  });
  await started;
  const printed = lines.find((line) => line.startsWith("console: "));
  try { await body(printed ? new URL(printed.slice("console: ".length)) : undefined, calls); }
  finally { stop.abort(); await running; }
}
const get = (link: URL, path: string) => fetch(new URL(path, link), { headers: { authorization: `Bearer ${link.hash.slice("#token=".length)}` } });

it("opens a console only when asked, and prints its one link", async () => {
  await host({ agentsDir: folders("me") }, async (link) => { expect(link).toBeUndefined(); });
  await host({ agentsDir: folders("me", "you"), console: { port: 0 } }, async (link) => {
    expect(link?.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(link?.hash).toMatch(/^#token=[0-9a-f]{64}$/);
    const listed = await (await get(link!, "/api/agents")).json();
    expect(listed).toMatchObject({ env: "local", agents: [{ id: "me" }, { id: "you" }] });
  });
});
