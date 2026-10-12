import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openMarketplaceAgent } from "../../dist/src/core/agent.js";

const [mode, boundary, directory, title] = process.argv.slice(2);
const input = {
  title, description: `Copy edit the product description for ${title}.`,
  budget: "20.00", pickup_deadline_hours: 24,
};
const spec = {
  role: "poster", model: "faux:faux-1",
  character: {
    name: "Receipt Test", businessName: "Small Shop",
    businessDescription: "Product descriptions", goals: "Hire a copy editor", budgetUsd: 20,
  },
  dials: { competence: 0.7, diligence: 0.6, priceSensitivity: 0.7, temperament: "brisk" },
  limits: { perJobUsd: 20, dailyUsd: 50 },
};
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const send = (message) => new Promise((resolve, reject) => {
  process.send(message, (error) => error ? reject(error) : resolve());
});
// A referenced timer keeps the deliberately stuck child alive until SIGKILL.
const pause = () => new Promise(() => { setInterval(() => {}, 1000); });
let agent;
let postEntries = 0;
let feeReads = 0;
let meReads = 0;
const marker = async (at) => {
  await send({ kind: "marker", boundary: at, status: await agent.status(), postEntries, feeReads, meReads });
  await pause();
};
async function command(runtime, args) {
  if (runtime.env !== "staging") throw new Error("fixture must not use production");
  if (args.length === 1 && args[0] === "me") {
    meReads++;
    return { outcome: "ok", data: { profile: { id: "33333333-3333-4333-8333-333333333333" } } };
  }
  if (args.length === 2 && args[0] === "platform" && args[1] === "config") {
    feeReads++;
    if (mode === "crash" && boundary === "fee-read") await marker(boundary);
    return { outcome: "ok", data: { config: { submission_fee: "3.00" } } };
  }
  const expected = ["post", `--title=${input.title}`, `--description=${input.description}`,
    "--budget=20.00", "--pickup-deadline-hours=24", "--yes"];
  if (JSON.stringify(args) !== JSON.stringify(expected)) throw new Error(`unexpected command: ${JSON.stringify(args)}`);
  postEntries++;
  if (mode === "crash" && boundary === "command-entered") await marker(boundary);
  // This file represents the remote service, not the agent's storage. Acceptance
  // is durable even if this process dies before returning the command result.
  const fd = openSync(join(directory, "receipts.jsonl"), "a", 0o600);
  try {
    writeSync(fd, JSON.stringify({ title: input.title, description: input.description }) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (mode === "crash" && boundary === "accepted") await marker(boundary);
  return { outcome: "ok", data: { task: { id: "00000000-0000-4000-8000-000000000001" } } };
}

async function attempt(id) {
  let result;
  let issued = false;
  faux.setResponses([
    () => {
      issued = true;
      return fauxAssistantMessage(fauxToolCall("post_task", input, { id }), { stopReason: "toolUse" });
    },
    (context) => {
      const message = context.messages.find((item) => item.role === "toolResult" && item.toolCallId === id);
      if (!message || message.isError) throw new Error(`missing successful tool result for ${id}`);
      const text = message.content.find((item) => item.type === "text");
      if (!text) throw new Error("missing tool result text");
      result = JSON.parse(text.text);
      return fauxAssistantMessage("Finished this attempt.");
    },
  ]);
  await agent.ping();
  await agent.waitForIdle();
  if (!issued || result === undefined || faux.getPendingResponseCount() !== 0) {
    throw new Error(`fresh attempt ${id} did not finish`);
  }
  return { id, result, status: await agent.status() };
}

async function main() {
  // Recovery of an interrupted run must settle before scheduling a fresh call.
  faux.setResponses(Array.from({ length: 16 }, () => fauxAssistantMessage("Recovery complete.")));
  agent = await openMarketplaceAgent({
    storePath: join(directory, "state.sqlite"), spec,
    runtime: { env: "staging", configPath: join(directory, "account.json") },
    models, command, recoverEveryMs: 50,
    log: (line) => process.stderr.write(line + "\n"),
  });
  if (mode === "hold") {
    await send({ kind: "opened", status: await agent.status() });
    await pause();
  } else if (mode === "crash") {
    const first = await attempt(`first-${process.pid}`);
    if (boundary !== "completed") throw new Error("expected to pause inside command");
    // Both the tool result and the completed run are committed by waitForIdle.
    await send({ kind: "completed-result", ...first });
    await marker(boundary);
  } else if (mode === "reopen") {
    await agent.waitForIdle();
    await agent.recover();
    await agent.waitForIdle();
    const before = await agent.status();
    const first = await attempt(`retry-${process.pid}-1`);
    const second = await attempt(`retry-${process.pid}-2`);
    const status = await agent.status();
    await agent.close();
    await send({ kind: "result", before, attempts: [first, second], status, postEntries, feeReads, meReads });
    process.disconnect();
  } else throw new Error(`unknown fixture mode: ${mode}`);
}
main().catch(async (error) => {
  await send({ kind: "fatal", error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
});
