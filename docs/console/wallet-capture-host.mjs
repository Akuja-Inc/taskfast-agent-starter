// A throwaway host for the wallet-refresh captures (#58): one temporary agent folder with
// a real store, a scripted model and a fake CLI. Nothing reaches a TaskFast server. Runs
// under Node from dist/ (pnpm build), prints the console link and runs until SIGTERM.
// SIGUSR2 admits a `payment_released` event and the fake server's balance moves from
// 50.00 to 68.00 USDC at the same moment. Every credential and ID is synthetic.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openMarketplaceAgent } from "../../dist/src/core/agent.js";
import { runAgents } from "../../dist/src/run.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const dir = mkdtempSync(join(tmpdir(), "wallet-host-"));
cpSync(new URL("../../examples/brisk-poster", import.meta.url), join(dir, "shop"), { recursive: true });
mkdirSync(join(dir, "shop", ".taskfast"), { recursive: true });
writeFileSync(join(dir, "shop", ".taskfast", "config.json"), "{}");
writeFileSync(join(dir, "shop", ".taskfast", "wallet-password"), "synthetic", { mode: 0o400 });

let paid = false;
async function command(_runtime, args) {
  const name = args.slice(0, 2).join(" ");
  if (name === "me") return { outcome: "ok", data: { profile: { id: "33333333-3333-4333-8333-333333333333" } } };
  // 50.00 and 68.00 USDC in micro-units.
  if (name === "wallet balance") return { outcome: "ok", data: { balance: { available_balance: paid ? "0x40d9900" : "0x2faf080" } } };
  return { outcome: "failed", error: `the demo CLI has no ${name}` };
}

const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());
try {
  await runAgents({
    agentsDir: dir, env: "local", signal: stop.signal, console: { port: 0 }, command,
    log: (line) => process.stdout.write(`${line}\n`),
    openAgent: async ({ spec, runtime, storePath }) => {
      const faux = fauxProvider({ models: [{ id: "test" }] });
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("Noted. Nothing else needs me yet.")));
      return openMarketplaceAgent({ spec: { ...spec, model: "faux:test" }, runtime, storePath, models, command, log: (line) => process.stdout.write(`shop: ${line}\n`) });
    },
    listen: ({ deliver, log }) => {
      log("sentinel connected");
      const pay = () => {
        paid = true;
        deliver({ event_id: "pay-1", event: "payment_released", task_id: TASK })
          .then(() => log("payment_released admitted"), (error) => log(`payment_released not delivered: ${error instanceof Error ? error.message : String(error)}`));
      };
      process.on("SIGUSR2", pay);
      return { close: async () => { process.off("SIGUSR2", pay); } };
    },
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
