// Regenerates the state.sqlite checked in beside this file. Run it only on a
// checkout whose @earendil-works/pi-durable and pi-ai resolve to 1.1.0, after
// `pnpm build`:
//
//   node test/fixtures/pi-1.1.0-store/make-store.mjs            # crash mid-write
//   node test/fixtures/pi-1.1.0-store/make-store.mjs --checkpoint <sqlite>
//   cp <sqlite> test/fixtures/pi-1.1.0-store/state.sqlite
//
// The first step opens a real marketplace agent on a real SQLite store, runs a
// faux model turn that completes one post and reserves a second, then exits the
// process while the second post's CLI dispatch is blocked, so the store keeps a
// version 1 `pi.tool` task interrupted mid-write and its policy action
// `reserved`. The checkpoint step reopens the store with storage only (no
// session, so no task recovery) and closes it, folding the write-ahead log into
// the main file without changing the committed state.
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openMarketplaceAgent } from "../../../dist/src/core/agent.js";
import { openAgentStorage } from "../../../dist/src/core/storage.js";
import { parseAgentSpec } from "../../../dist/src/core/spec.js";

const agentId = "33333333-3333-4333-8333-333333333333";
const post = { title: "Edit the guide", description: "Copy edit the short guide.", budget: "10.00", pickup_deadline_hours: 24 };
const spec = { ...parseAgentSpec(JSON.parse(readFileSync(new URL("../../../examples/brisk-poster.json", import.meta.url), "utf8"))), model: "faux:test", limits: { dailyUsd: 10, perJobUsd: 4 } };

if (process.argv[2] === "--checkpoint") {
  const storage = await openAgentStorage(process.argv[3]);
  await storage.close(BACKGROUND_CONTEXT);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "pi-1.1.0-store-"));
const storePath = join(dir, "state.sqlite");
const faux = fauxProvider({ models: [{ id: "test" }] });
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("remember", { note: "Keep the guide concise." }), fauxToolCall("post_task", post)], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxToolCall("post_task", { ...post, title: "Edit another guide" })], { stopReason: "toolUse" }),
]);
let writes = 0;
let entered = false;
const agent = await openMarketplaceAgent({
  storePath, spec, runtime: { env: "staging", configPath: join(dir, "config.json") }, models,
  command: async (_runtime, args) => {
    if (args[0] === "me") return { outcome: "ok", data: { profile: { id: agentId } } };
    if (args[0] === "platform") return { outcome: "ok", data: { config: { submission_fee: "3.00" } } };
    writes++;
    if (writes === 1) return { outcome: "ok", data: { accepted: true } };
    entered = true;
    await new Promise(() => {}); // The crash point: this dispatch never settles.
  },
});
await agent.ping();
while (!entered) await new Promise((done) => setTimeout(done, 10));
const status = await agent.status();
const states = Object.values(status.actions).map((action) => action.status).sort();
if (!entered || states.length !== 2 || states[0] !== "done" || states[1] !== "reserved") throw new Error(`unexpected fixture state: ${states.join(",")}`);
console.log(storePath);
process.exit(0);
