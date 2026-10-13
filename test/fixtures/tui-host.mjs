// A throwaway host for the terminal UI's smoke test and screenshots: two temporary
// agent folders with real stores, a scripted model and a fake CLI. Nothing reaches a
// TaskFast server. Runs under Node from dist/ (pnpm build); prints the console link
// and runs until SIGTERM. Every credential and ID is synthetic.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openMarketplaceAgent } from "../../dist/src/core/agent.js";
import { runAgents } from "../../dist/src/run.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const BID = "44444444-4444-4444-8444-444444444444";
const dir = mkdtempSync(join(tmpdir(), "tui-host-"));
const examples = new URL("../../examples/", import.meta.url);
for (const [id, file] of [["shop", "brisk-poster.json"], ["worker", "careful-worker.json"]]) {
  mkdirSync(join(dir, id, ".taskfast"), { recursive: true });
  writeFileSync(join(dir, id, "agent.json"), readFileSync(new URL(file, examples)));
  writeFileSync(join(dir, id, ".taskfast", "config.json"), "{}");
  writeFileSync(join(dir, id, ".taskfast", "wallet-password"), "synthetic", { mode: 0o400 });
}
writeFileSync(join(dir, "shop", ".taskfast", "dead-letter.jsonl"), `${JSON.stringify({ at: "2026-10-13T08:00:00Z", reason: "event has no name", line: JSON.stringify({ event_id: "bad-1", task_id: OTHER }) })}\n`);

// The scripted model: a check-in that lists tasks, claims one, sends a message the server
// refuses and accepts a bid whose answer never arrives; then plain replies.
const scripts = {
  shop: [
    fauxAssistantMessage([
      fauxToolCall("task_list", {}, { id: "c1" }),
      fauxToolCall("task_claim", { task_id: TASK }, { id: "c2" }),
      fauxToolCall("message_send", { task_id: OTHER, content: "Can you start today?" }, { id: "c3" }),
      fauxToolCall("bid_accept", { task_id: OTHER, bid_id: BID }, { id: "c4" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("Claimed the photo edit. The message was refused and the bid acceptance timed out, so it is uncertain: please check it before I do anything else on that task."),
    fauxAssistantMessage("A new bid arrived on the copywriting job. I will wait for your check on the uncertain acceptance first."),
    ...Array.from({ length: 20 }, () => fauxAssistantMessage("Understood. I will follow that from my next action.")),
  ],
  worker: Array.from({ length: 20 }, () => fauxAssistantMessage("Nothing new to bid on yet.")),
};
// The fake CLI: reads succeed, the message is refused, the bid acceptance is uncertain.
async function command(_runtime, args) {
  const name = args.slice(0, 2).join(" ");
  if (name === "me") return { outcome: "ok", data: { profile: { id: "33333333-3333-4333-8333-333333333333" } } };
  if (name === "wallet balance") return { outcome: "ok", data: { balance: { available_balance: "0x2faf080" } } };
  if (name === "task list") return { outcome: "ok", data: { tasks: [{ id: TASK }, { id: OTHER }] } };
  if (name === "task get") {
    const id = args.at(-1);
    return { outcome: "ok", data: { task: id === TASK ? { id, title: "Edit 12 product photos", status: "in_progress", budget_max: "18.00", worker_agent_id: "33333333-3333-4333-8333-333333333333" } : { id, title: "Write 5 product descriptions", status: "open", budget_max: "20.00" } } };
  }
  if (name === "task claim") return { outcome: "ok", data: { task: { id: TASK, status: "in_progress" } } };
  if (name === "message send") return { outcome: "failed", error: "message refused: you are not a party to this task" };
  if (name === "bid accept") return { outcome: "uncertain", error: "timed out waiting for the server" };
  return { outcome: "failed", error: `the demo CLI has no ${name}` };
}

const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());
try {
  await runAgents({
    agentsDir: dir, env: "local", signal: stop.signal, console: { port: Number(process.env.TUI_HOST_PORT ?? 0) }, command,
    log: (line) => process.stdout.write(`${line}\n`),
    openAgent: async ({ id, spec, runtime, storePath }) => {
      const faux = fauxProvider({ models: [{ id: "test" }] });
      const models = createModels();
      models.setProvider(faux.provider);
      const script = scripts[id];
      if (!script) throw new Error(`no scripted model for the ${id} agent`);
      faux.setResponses(script);
      return openMarketplaceAgent({ spec: { ...spec, model: "faux:test" }, runtime, storePath, models, command, log: (line) => process.stdout.write(`${id}: ${line}\n`) });
    },
    // The stream connects at once; the shop's one marketplace event follows its first check-in.
    listen: ({ deliver, log }) => {
      log("sentinel connected");
      // A rejection while shutting down must be logged, not kill the process before the cleanup below.
      const timer = setTimeout(() => deliver({ event_id: "e1", event: "bid.created", task_id: OTHER })
        .catch((error) => log(`bid.created not delivered: ${error instanceof Error ? error.message : String(error)}`)), 1500);
      return { close: async () => clearTimeout(timer) };
    },
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
