import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const FIXTURE = join(ROOT, "test", "fixtures", "runtime-crash.mjs");
const DEADLINE_MS = 15_000;
const directories: string[] = [];
const children: ReturnType<typeof start>[] = [];

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object report");
  return Object.fromEntries(Object.entries(value));
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected an array report");
  return value;
}
function bounded<T>({ work, label }: { work: Promise<T>; label: string }): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`deadline waiting for ${label}`)), DEADLINE_MS);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
function start({ mode, boundary, dir, title }: { mode: "crash" | "reopen" | "hold"; boundary: string; dir: string; title: string }) {
  const child = spawn(process.execPath, [FIXTURE, mode, boundary, dir, title], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: Record<string, unknown>[] = [];
  let diagnostics = "";
  let ended = false;
  let spawnError: Error | undefined;
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) throw new Error("fixture requires piped stdout and stderr");
  stdout.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-20_000); });
  stderr.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-20_000); });
  child.on("error", (error) => { spawnError = error; });
  child.on("message", (message: unknown) => { messages.push(record(message)); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => { ended = true; resolve({ code, signal }); });
  });
  function waitFor(kind: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`deadline waiting for ${kind}: ${diagnostics}`)), DEADLINE_MS);
      function finish(error?: Error, message?: Record<string, unknown>) {
        clearTimeout(timer);
        child.off("message", check);
        child.off("close", check);
        child.off("error", check);
        if (error) reject(error);
        else if (message) resolve(message);
      }
      function check() {
        const match = messages.find((message) => message.kind === kind);
        if (match) return finish(undefined, match);
        const fatal = messages.find((message) => message.kind === "fatal");
        if (fatal) return finish(new Error(`fixture failed: ${String(fatal.error)}\n${diagnostics}`));
        if (spawnError || ended) finish(spawnError ?? new Error(`child exited before ${kind}: ${diagnostics}`));
      }
      child.on("message", check);
      child.on("close", check);
      child.on("error", check);
      check();
    });
  }
  return {
    waitFor,
    exit: () => bounded({ work: exit, label: "child exit" }),
    kill: async () => {
      if (!ended) child.kill("SIGKILL");
      return bounded({ work: exit, label: "SIGKILL exit" });
    },
  };
}
function launch(options: Parameters<typeof start>[0]) {
  const child = start(options);
  children.push(child);
  return child;
}
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "marketplace-crash-"));
  directories.push(dir);
  return dir;
}
function receipts(dir: string): unknown[] {
  const file = join(dir, "receipts.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line): unknown => JSON.parse(line));
}
function assertState({ value, status }: { value: unknown; status: "done" | "reserved" | "uncertain" | "available" }) {
  const state = record(value);
  const actions = record(state.actions);
  const spend = record(state.spend);
  if (status === "available") {
    expect(actions).toEqual({});
    expect(spend).toEqual({});
  } else {
    expect(Object.keys(actions)).toHaveLength(1);
    expect(Object.keys(actions)[0]).toMatch(/^post:/);
    expect(Object.values(actions)).toEqual([expect.objectContaining({ status, amount: 3 })]);
    expect(Object.values(spend)).toEqual([3]);
  }
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.kill()));
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe("marketplace process-crash boundaries", () => {
  it.each([
    { boundary: "fee-read", initial: "available", recovered: "available", effects: 0, entered: 0 },
    { boundary: "command-entered", initial: "reserved", recovered: "uncertain", effects: 0, entered: 1 },
    { boundary: "accepted", initial: "reserved", recovered: "uncertain", effects: 1, entered: 1 },
    { boundary: "completed", initial: "done", recovered: "done", effects: 1, entered: 1 },
  ] satisfies { boundary: string; initial: "available" | "reserved" | "done"; recovered: "available" | "uncertain" | "done"; effects: number; entered: number }[])(
    "SIGKILL at $boundary preserves admission, spend and remote effects",
    async ({ boundary, initial, recovered, effects, entered }) => {
      const dir = directory();
      const title = `Copy edit ${randomUUID()}`;
      const crashed = launch({ mode: "crash", boundary, dir, title });
      const marker = await crashed.waitFor("marker");
      expect(marker.boundary).toBe(boundary);
      expect(marker.postEntries).toBe(entered);
      expect(marker.feeReads).toBe(1);
      expect(marker.meReads).toBe(1);
      assertState({ value: marker.status, status: initial });
      if (boundary === "completed") {
        const completed = await crashed.waitFor("completed-result");
        expect(completed.result).toEqual({ task: { id: "00000000-0000-4000-8000-000000000001" } });
        assertState({ value: completed.status, status: "done" });
      }
      expect(receipts(dir)).toHaveLength(effects);
      expect(await crashed.kill()).toEqual({ code: null, signal: "SIGKILL" });
      expect(receipts(dir)).toHaveLength(effects);

      const reopened = launch({ mode: "reopen", boundary, dir, title });
      const report = await reopened.waitFor("result");
      expect(await reopened.exit()).toEqual({ code: 0, signal: null });
      expect(report.meReads).toBe(1);
      assertState({ value: report.before, status: recovered });
      const attempts = array(report.attempts).map(record);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.id).not.toBe(attempts[1]?.id);
      expect(attempts.map((attempt) => attempt.id)).toEqual([
        expect.stringMatching(/^retry-\d+-1$/), expect.stringMatching(/^retry-\d+-2$/),
      ]);
      if (recovered === "available") {
        expect(report.postEntries).toBe(1);
        expect(report.feeReads).toBe(1);
        expect(attempts[0]?.result).toEqual({ task: { id: "00000000-0000-4000-8000-000000000001" } });
        expect(attempts[1]?.result).toMatchObject({ skipped: "already done" });
      } else {
        expect(report.postEntries).toBe(0);
        expect(report.feeReads).toBe(0);
        const skipped = recovered === "done" ? "already done" : "outcome unknown; read the current state";
        for (const attempt of attempts) expect(attempt.result).toMatchObject({ skipped });
      }
      const finalStatus = recovered === "available" ? "done" : recovered;
      for (const attempt of attempts) assertState({ value: attempt.status, status: finalStatus });
      assertState({ value: report.status, status: finalStatus });
      const expectedReceipts = effects + (recovered === "available" ? 1 : 0);
      expect(receipts(dir)).toEqual(Array.from({ length: expectedReceipts }, () => ({
        title, description: `Copy edit the product description for ${title}.`,
      })));

      // Another process and two more new call IDs cannot reset the ledger.
      const again = launch({ mode: "reopen", boundary, dir, title });
      const permanent = await again.waitFor("result");
      expect(await again.exit()).toEqual({ code: 0, signal: null });
      expect(permanent.before).toEqual(report.status);
      expect(permanent.status).toEqual(report.status);
      expect(permanent.meReads).toBe(1);
      expect(permanent.postEntries).toBe(0);
      expect(permanent.feeReads).toBe(0);
      for (const attempt of array(permanent.attempts).map(record)) {
        expect(attempt.result).toMatchObject({
          skipped: finalStatus === "done" ? "already done" : "outcome unknown; read the current state",
        });
      }
      expect(receipts(dir)).toHaveLength(expectedReceipts);
    }, 60_000,
  );

  it("refuses a second process owner and releases ownership automatically on SIGKILL", async () => {
    const dir = directory();
    const title = `Owner ${randomUUID()}`;
    const owner = launch({ mode: "hold", boundary: "owner", dir, title });
    await owner.waitFor("opened");
    const contender = launch({ mode: "hold", boundary: "owner", dir, title });
    const refused = await contender.waitFor("fatal");
    expect(refused.error).toEqual(expect.stringContaining("agent store is already owned"));
    expect(await contender.exit()).toEqual({ code: 1, signal: null });
    expect(await owner.kill()).toEqual({ code: null, signal: "SIGKILL" });
    const successor = launch({ mode: "hold", boundary: "owner", dir, title });
    const opened = await successor.waitFor("opened");
    assertState({ value: opened.status, status: "available" });
    expect(receipts(dir)).toEqual([]);
    expect(await successor.kill()).toEqual({ code: null, signal: "SIGKILL" });
  }, 60_000);
});
