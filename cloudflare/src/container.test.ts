import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../../src/core/tools.js";
import { SAMPLES } from "../../test/cli-parity.js";
import { commandPath, containerCommand, READ_COMMANDS, type ContainerCall } from "./container.js";

const runtime = { env: "staging" as const, configPath: "/bundle/agent/.taskfast/config.json" };
const capture = (path: string) => readFileSync(join(import.meta.dirname, "../../test/fixtures/cli", path), "utf8");

describe("READ_COMMANDS", () => {
  const paths = (kind: (k: string) => boolean) => new Set(Object.entries(TOOLS).filter(([, tool]) => kind(tool.kind)).flatMap(([name, tool]) => {
    const samples = SAMPLES[name];
    return (Array.isArray(samples) ? samples : [samples]).map((input) => commandPath(tool.args(input as never)));
  }));
  it("holds every read tool's command", () => {
    for (const path of paths((kind) => kind === "read")) expect(READ_COMMANDS).toContain(path);
  });
  it("holds no write or money tool's command", () => {
    for (const path of paths((kind) => kind !== "read" && kind !== "memory")) expect(READ_COMMANDS).not.toContain(path);
  });
});

describe("containerCommand", () => {
  const command = (reply: () => Promise<Response>) => {
    const sent: ContainerCall[] = [];
    return { sent, run: containerCommand({ config: '{"api_key":"k"}', call: async (body) => { sent.push(body); return reply(); } }) };
  };
  it("sends the env first, then the read, with the config", async () => {
    const { sent, run } = command(async () => Response.json({ stdout: capture("task-bids.json"), stderr: "" }));
    const result = await run(runtime, ["task", "bids", "--", "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b"]);
    expect(sent).toEqual([{ args: ["--env", "staging", "task", "bids", "--", "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b"], config: '{"api_key":"k"}' }]);
    expect(result.outcome).toBe("ok");
    expect(result.data).toEqual(JSON.parse(capture("task-bids.json")).data);
  });
  it("refuses a write before anything leaves the DO", async () => {
    const { sent, run } = command(async () => { throw new Error("must not be called"); });
    expect(await run(runtime, ["bid", "create", "--price=10.00", "--", "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b"])).toEqual({ outcome: "failed", error: "unavailable: marketplace writes are not deployed yet" });
    expect(sent).toEqual([]);
  });
  it("keeps a captured refusal a known refusal", async () => {
    const { run } = command(async () => Response.json({ stdout: capture("gh70/claim-bond-pending.json"), stderr: "", failure: "exit 7" }));
    expect((await run(runtime, ["me"])).outcome).toBe("failed");
  });
  it.each([
    ["the Container is unreachable", async () => { throw new Error("connection reset"); }],
    ["the Container answers 500", async () => new Response("boom", { status: 500 })],
    ["the reply is not JSON", async () => new Response("<html>", { status: 200 })],
    ["the CLI cannot reach the server", async () => Response.json({ stdout: '{"ok":false,"error":{"code":"network","message":"down"}}', stderr: "", failure: "exit 6" })],
    ["the CLI prints nothing", async () => Response.json({ stdout: "", stderr: "killed", failure: "timeout" })],
  ])("is uncertain when %s", async (_name, reply) => {
    const { run } = command(reply);
    expect((await run(runtime, ["me"])).outcome).toBe("uncertain");
  });
});
