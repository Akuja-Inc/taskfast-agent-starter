// Local browser evidence only. No accounts, stores, model calls or marketplace children.
// TASKFAST_KIT_ROOT can select a separately built baseline checkout for before captures.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const root = resolve(process.env.TASKFAST_KIT_ROOT || ".");
const { startConsole } = await import(pathToFileURL(resolve(root, "dist/src/console.js")));
const { initialOperator } = await import(pathToFileURL(resolve(root, "dist/src/core/operator.js")));
const at = Date.now();
const task = "11111111-1111-4111-8111-111111111111";
const agents = ["alpha", "beta"].map((id) => ({
  id,
  spec: { role: "worker", instructions: "You are " + id + ", a careful copy editor.", model: "faux:fixture", dials: { competence: 0.9, diligence: 0.95, priceSensitivity: 0.5, temperament: "exacting" }, limits: { dailyUsd: 50, perJobUsd: 20 } },
  agent: {
    status: async () => ({ identity: { env: "local", agentId: "33333333-3333-4333-8333-333333333333" }, actions: {}, spend: {}, memory: [] }),
    transcript: async () => [
      { role: "user", timestamp: at - 180000, content: "Marketplace event:\n" + JSON.stringify({ event_id: "fixture-event", event: "task.created", task_id: task }) },
      { role: "assistant", timestamp: at - 179000, content: [{ type: "text", text: "I checked the brief and read the task before deciding whether to bid." }, { type: "toolCall", id: "fixture-call", name: "task_get", arguments: { task_id: task } }] },
      { role: "toolResult", toolCallId: "fixture-call", toolName: "task_get", timestamp: at - 178000, isError: false, content: [{ type: "text", text: '{"task":{"title":"Review a short newsletter","status":"open"}}' }] },
    ],
    changes: () => () => {},
    operator: {
      state: async () => ({ ...initialOperator(), paused: true }), events: async () => ({}), queued: async () => [],
    },
  },
}));
const host = await startConsole({ port: 0, token: "a".repeat(64), env: "local", agents: () => agents });
console.log(JSON.stringify({ port: host.port, baseUrl: `http://127.0.0.1:${host.port}` }));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void host.close().then(() => process.exit()); });
