import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../../src/core/tools.js";
import { SAMPLES } from "../../test/cli-parity.js";
import { commandPath, COMMANDS, containerCommand, type ContainerCall } from "./container.js";

const runtime = { env: "staging" as const, configPath: "/bundle/agent/.taskfast/config.json" };
const capture = (path: string) => readFileSync(join(import.meta.dirname, "../../test/fixtures/cli", path), "utf8");
const TASK = "4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b";
const wallet = { keystore: '{"version":3}', password: "correct horse battery" };
const dir = mkdtempSync(join(tmpdir(), "container-"));
const ARTIFACT = `.pi-state/artifacts/${TASK}/abc123/results.json`;
mkdirSync(join(dir, ".pi-state/artifacts", TASK, "abc123"), { recursive: true });
writeFileSync(join(dir, ARTIFACT), '{"results":[1,2,3]}\n');

describe("COMMANDS", () => {
  // Policy and money.ts send these themselves (cleanup and the bond token's decimals).
  const internal = ["artifact delete", "cast call"];
  const toolPaths = new Set(Object.entries(TOOLS).filter(([, tool]) => tool.kind !== "memory").flatMap(([name, tool]) => {
    const samples = SAMPLES[name];
    return (Array.isArray(samples) ? samples : [samples]).map((input) => commandPath(tool.args(input as never)));
  }));
  it("holds exactly every tool's command and policy's own", () => {
    expect([...COMMANDS].sort()).toEqual([...new Set([...toolPaths, ...internal])].sort());
  });
});

describe("containerCommand", () => {
  function command(reply: () => Promise<Response>, o: { ready?: () => Promise<boolean>; wallet?: typeof wallet | null } = {}) {
    const sent: ContainerCall[] = [];
    let checks = 0;
    const run = containerCommand({
      config: '{"api_key":"k"}',
      folder: dir,
      ...(o.wallet === null ? {} : { wallet: o.wallet ?? wallet }),
      ready: async () => { checks++; return o.ready ? o.ready() : true; },
      call: async (body) => { sent.push(body); return reply(); },
    });
    return { sent, run, checks: () => checks };
  }
  const ok = async () => Response.json({ stdout: capture("task-bids.json"), stderr: "" });

  it("sends the env first, then the command, with the config and no wallet for a read", async () => {
    const { sent, run } = command(ok);
    const result = await run(runtime, ["task", "bids", "--", TASK]);
    expect(sent).toEqual([{ args: ["--env", "staging", "task", "bids", "--", TASK], config: '{"api_key":"k"}' }]);
    expect(result.outcome).toBe("ok");
    expect(result.data).toEqual(JSON.parse(capture("task-bids.json")).data);
  });
  it("sends a write that does not sign without the wallet", async () => {
    const { sent, run } = command(ok);
    await run(runtime, ["bid", "create", "--price=10.00", "--", TASK]);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]).sort()).toEqual(["args", "config"]);
  });
  it.each([["post", "--title=Edit"], ["settle"], ["escrow", "sign"], ["bond", "post"]])("sends the wallet only with a signing command: %s %s", async (...head) => {
    const { sent, run } = command(ok);
    await run(runtime, [...head, "--", TASK]);
    expect(sent[0]).toMatchObject({ keystore: wallet.keystore, password: wallet.password });
  });
  it("refuses a signing command before anything leaves the DO when no wallet is set", async () => {
    const { sent, run, checks } = command(ok, { wallet: null });
    expect(await run(runtime, ["bond", "post", "--dry-run", "--", TASK])).toEqual({ outcome: "failed", error: "keystore: the WALLET_KEYSTORE and WALLET_PASSWORD secrets are not set" });
    expect([sent.length, checks()]).toEqual([0, 0]);
  });
  it("ships each artifact a submit names, read from the folder, with its relative path", async () => {
    const { sent, run } = command(ok);
    await run(runtime, ["task", "submit", "--summary=Done", `--artifact=${ARTIFACT}`, "--", TASK]);
    expect(sent[0].args).toContain(`--artifact=${ARTIFACT}`);
    expect(sent[0].files).toEqual([{ path: ARTIFACT, base64: Buffer.from('{"results":[1,2,3]}\n').toString("base64") }]);
  });
  it.each([
    ["a missing file", `.pi-state/artifacts/${TASK}/abc123/absent.json`],
    ["a path outside the artifacts folder", ".taskfast/config.json"],
    ["a traversal", `.pi-state/artifacts/../../etc/passwd`],
  ])("refuses %s before anything leaves the DO", async (_name, path) => {
    const { sent, run } = command(ok);
    expect((await run(runtime, ["task", "submit", "--summary=Done", `--artifact=${path}`, "--", TASK])).outcome).toBe("failed");
    expect(sent).toEqual([]);
  });
  it("refuses a command the kit never sends", async () => {
    const { sent, run } = command(ok);
    expect((await run(runtime, ["webhook", "register"])).outcome).toBe("failed");
    expect((await run(runtime, ["config", "set", "environment", "prod"])).outcome).toBe("failed");
    expect(sent).toEqual([]);
  });
  it.each([
    ["answers not ready", async () => false],
    ["fails to start", async () => { throw new Error("Container failed to start"); }],
  ])("is a known refusal, with nothing sent, when the Container %s", async (_name, ready) => {
    const { sent, run } = command(ok, { ready });
    expect(await run(runtime, ["bid", "create", "--price=10.00", "--", TASK])).toEqual({ outcome: "failed", error: "unavailable: the CLI Container did not start" });
    expect(sent).toEqual([]);
  });
  it("keeps a captured refusal a known refusal", async () => {
    const { run } = command(async () => Response.json({ stdout: capture("gh70/claim-bond-pending.json"), stderr: "", failure: "exit 7" }));
    expect((await run(runtime, ["task", "claim", TASK])).outcome).toBe("failed");
  });
  it.each([
    ["the request fails after the health check", async () => { throw new Error("connection reset"); }],
    ["the Container answers 500", async () => new Response("boom", { status: 500 })],
    ["the reply is not JSON", async () => new Response("<html>", { status: 200 })],
    ["the CLI cannot reach the server", async () => Response.json({ stdout: '{"ok":false,"error":{"code":"network","message":"down"}}', stderr: "", failure: "exit 6" })],
    ["the CLI prints nothing", async () => Response.json({ stdout: "", stderr: "killed", failure: "timeout" })],
  ])("is uncertain when %s", async (_name, reply) => {
    const { run } = command(reply);
    expect((await run(runtime, ["bid", "create", "--price=10.00", "--", TASK])).outcome).toBe("uncertain");
  });
});
