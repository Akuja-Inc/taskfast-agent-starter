import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect, it, vi } from "vitest";
import { openSchedulingGate } from "./gate.js";

function marker() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function open(startHeld = false) {
  const state = { paused: false };
  const pass = vi.fn(async () => {});
  const logs: string[] = [];
  const snapshot = vi.fn(async () => state);
  const gate = openSchedulingGate({
    read: { snapshot }, context: BACKGROUND_CONTEXT, startHeld,
    pass, log: (line) => logs.push(line),
  });
  return { gate, state, pass, logs, snapshot };
}

it("stops new work while paused, held or closed", async () => {
  const { gate, state } = open();
  expect(await gate.mayStart()).toBe(true);
  state.paused = true;
  expect(await gate.mayStart()).toBe(false);
  state.paused = false;
  const release = gate.hold();
  expect(await gate.mayStart()).toBe(false);
  await release();
  expect(await gate.mayStart()).toBe(true);
  await gate.close();
  expect(await gate.mayStart()).toBe(false);
  expect(() => gate.hold()).toThrow("the agent is closed");
});

it("rechecks holds and close after reading the durable pause", async () => {
  for (const change of ["hold", "close"] as const) {
    const { gate, snapshot } = open();
    const reading = marker();
    snapshot.mockImplementationOnce(async () => { await reading.promise; return { paused: false }; });
    const allowed = gate.mayStart();
    if (change === "hold") gate.hold();
    else await gate.close();
    reading.resolve();
    expect(await allowed).toBe(false);
  }
});

it("keeps nested holds independent and releases each one only once", async () => {
  const { gate, pass } = open();
  const first = gate.hold();
  const second = gate.hold();
  await first();
  await first();
  expect(await gate.mayStart()).toBe(false);
  expect(pass).toHaveBeenCalledTimes(1);
  await second();
  await second();
  expect(await gate.mayStart()).toBe(true);
  expect(pass).toHaveBeenCalledTimes(2);
});

it("releases the initial hold once without releasing another hold", async () => {
  const { gate, pass } = open(true);
  const release = gate.hold();
  expect(await gate.mayStart()).toBe(false);
  await gate.releaseInitial();
  await gate.releaseInitial();
  expect(await gate.mayStart()).toBe(false);
  expect(pass).toHaveBeenCalledTimes(1);
  await release();
  expect(await gate.mayStart()).toBe(true);
});

it("runs single-flight and settled waits for that pass", async () => {
  const { gate, pass } = open();
  const waiting = marker();
  pass.mockImplementationOnce(() => waiting.promise);
  const first = gate.run();
  expect(gate.run()).toBe(first);
  let settled = false;
  const done = gate.settled().then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  waiting.resolve();
  await Promise.all([first, done]);
  expect(pass).toHaveBeenCalledTimes(1);
});

it("fresh runs one pass when idle, but joins then reruns an inflight pass", async () => {
  const { gate, pass } = open();
  await gate.fresh();
  expect(pass).toHaveBeenCalledTimes(1);
  const waiting = marker();
  pass.mockImplementationOnce(() => waiting.promise);
  const stale = gate.run();
  const fresh = gate.fresh();
  waiting.resolve();
  await Promise.all([stale, fresh]);
  expect(pass).toHaveBeenCalledTimes(3);
});

it("concurrent fresh callers share both the joined and fresh passes", async () => {
  const { gate, pass } = open();
  const waiting = marker();
  pass.mockImplementationOnce(() => waiting.promise);
  const stale = gate.run();
  const first = gate.fresh();
  const second = gate.fresh();
  waiting.resolve();
  await Promise.all([stale, first, second]);
  expect(pass).toHaveBeenCalledTimes(2);
});

it("fresh logs a failed pass once and never rejects", async () => {
  const { gate, pass, logs } = open();
  pass.mockRejectedValueOnce(new Error("broken"));
  await gate.fresh();
  expect(logs).toEqual(["recovery: Error: broken"]);
  pass.mockRejectedValueOnce(new Error("shared"));
  const failed = gate.run();
  const first = gate.fresh();
  const second = gate.fresh();
  await expect(failed).rejects.toThrow("shared");
  await Promise.all([first, second]);
  expect(logs).toEqual(["recovery: Error: broken", "recovery: Error: shared"]);
});

it("run rejects without logging so its caller keeps the error boundary", async () => {
  const { gate, pass, logs } = open();
  pass.mockRejectedValueOnce(new Error("storage"));
  await expect(gate.run()).rejects.toThrow("storage");
  expect(logs).toEqual([]);
});

it("background recovery and fresh observers log the same failed pass only once", async () => {
  const { gate, pass, logs } = open();
  const waiting = marker();
  pass.mockImplementationOnce(async () => { await waiting.promise; throw new Error("shared"); });
  const background = gate.runLogged();
  const fresh = gate.fresh();
  waiting.resolve();
  await Promise.all([background, fresh]);
  expect(logs).toEqual(["recovery: Error: shared"]);
});

it("keeps the event recovery prefix without logging another observer's failure twice", async () => {
  const { gate, pass, logs } = open();
  pass.mockRejectedValueOnce(new Error("event"));
  await Promise.all([gate.runLogged("event recovery"), gate.runLogged(), gate.fresh()]);
  expect(logs).toEqual(["event recovery: Error: event"]);
});

it("close waits for a rejected pass, ignores it and stops fresh reruns", async () => {
  const { gate, pass } = open();
  const waiting = marker();
  pass.mockImplementationOnce(async () => { await waiting.promise; throw new Error("storage"); });
  const running = gate.run();
  const fresh = gate.fresh();
  const closing = gate.close();
  const rejection = expect(running).rejects.toThrow("storage");
  waiting.resolve();
  await Promise.all([rejection, fresh, closing]);
  await gate.run();
  await gate.fresh();
  expect(pass).toHaveBeenCalledTimes(1);
});

it("does not run a hold release after close", async () => {
  const { gate, pass } = open(true);
  const release = gate.hold();
  await gate.close();
  await release();
  await gate.releaseInitial();
  expect(pass).not.toHaveBeenCalled();
});
