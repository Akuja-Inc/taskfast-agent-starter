// Offline browser evidence for #104. All configs and handles are synthetic.
// No model, marketplace command, store or event stream is opened.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialOperator } from "../../dist/src/core/operator.js";
import { runAgents } from "../../dist/src/run.js";

const dir = mkdtempSync(join(tmpdir(), "environment-host-"));
for (const [id, environment] of [["local-editor", "local"], ["staging-writer", "staging"], ["production-poster", "prod"]]) {
  const home = join(dir, id);
  cpSync(new URL("../../examples/careful-worker/", import.meta.url), home, { recursive: true });
  mkdirSync(join(home, ".taskfast"));
  writeFileSync(join(home, ".taskfast/config.json"), JSON.stringify({ environment }));
}
const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());
try {
  await runAgents({
    agentsDir: dir, env: "local", signal: stop.signal, console: { port: 0 },
    log: (line) => process.stdout.write(`${line}\n`),
    command: async () => ({ outcome: "failed", error: "offline evidence fixture" }),
    listen: () => ({ close: async () => {} }),
    openAgent: async () => ({
      closed: Promise.resolve({ reason: "closed" }), deliver: async () => {}, ping: async () => {}, close: async () => {},
      status: async () => ({ identity: { env: "local", agentId: "33333333-3333-4333-8333-333333333333" }, actions: {}, spend: {}, memory: [] }),
      transcript: async () => [], changes: () => () => {},
      operator: {
        state: async () => initialOperator(), events: async () => ({}), queued: async () => [],
        steer: async () => "not_found", withdraw: async () => "not_found", setFrozen: async () => {}, setPaused: async () => {},
        message: async () => {}, addOrder: async () => {}, removeOrder: async () => {}, markChecked: async () => {}, retryEvent: async () => {},
      },
    }),
  });
} finally { rmSync(dir, { recursive: true, force: true }); }
