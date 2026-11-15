import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { example } from "../../test/example.js";
import { openMarketplaceAgent, type MarketplaceAgent } from "./agent.js";
import { artifacts, mediaDigest, saveMedia } from "./artifacts.js";
import type { CliResult } from "./cli.js";
import { parseAgentSpec } from "./spec.js";

it.each(["submit", "remedy"] as const)("dispatches the pre-reservation bytes for a %s even when disk changes during cleanup", async (kind) => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-delivery-"));
  const task = "11111111-1111-4111-8111-111111111111";
  const agentId = "33333333-3333-4333-8333-333333333333";
  const uploadId = "550e8400-e29b-41d4-a716-446655440001";
  const bytes = Buffer.from("%PDF-test delivery");
  const media = `media:${mediaDigest(bytes)}.pdf`;
  const input = { task_id: task, summary: "Done", artifacts: [{ name: "report.pdf", media }] };
  const plan = artifacts(input.artifacts, task);
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  let agent: MarketplaceAgent | undefined;
  const steps: string[] = [];
  try {
    saveMedia(dir, "application/pdf", bytes.toString("base64"));
    agent = await openMarketplaceAgent({
      storePath: join(dir, "state.sqlite"),
      runtime: { env: "staging", configPath: join(dir, "config.json") },
      spec: { ...parseAgentSpec(example("careful-worker")), model: "faux:test" },
      models,
      command: async (_runtime, args, files): Promise<CliResult> => {
        if (args[0] === "me") return { outcome: "ok", data: { profile: { id: agentId } } };
        if (args[0] === "artifact") {
          expect(Object.keys((await agent!.status()).actions)).toEqual([]);
          expect(files).toBeUndefined();
          steps.push(args[1]!);
          if (args[1] === "list") {
            expect(readFileSync(join(dir, plan[0]!.path))).toEqual(bytes);
            writeFileSync(join(dir, plan[0]!.path), "changed artifact");
            writeFileSync(join(dir, ".pi-state/media", `${mediaDigest(bytes)}.pdf`), "changed source");
            return { outcome: "ok", data: { artifacts: [{ id: uploadId, uploaded_by_id: agentId }] } };
          }
          expect(args).toEqual(["artifact", "delete", "--", task, uploadId]);
          return { outcome: "ok" };
        }
        steps.push(args[1]!);
        expect(Object.values((await agent!.status()).actions).map((action) => action.status)).toEqual(["reserved"]);
        expect(files).toEqual([{ path: plan[0]!.path, bytes }]);
        return { outcome: "ok", data: { accepted: true } };
      },
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(`task_${kind}`, input)], { stopReason: "toolUse" }),
      fauxAssistantMessage("Delivered."),
    ]);
    await agent.ping();
    await agent.waitForIdle();
    expect(steps).toEqual(kind === "submit" ? ["list", "delete", "submit"] : ["remedy"]);
    expect(Object.values((await agent.status()).actions).map((action) => action.status)).toEqual(["done"]);
  } finally {
    await agent?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
