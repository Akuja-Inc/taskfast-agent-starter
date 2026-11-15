import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { Operator } from "./operator.js";

export interface SchedulingGateHost {
  read: Pick<Harness, "snapshot">;
  context: Context;
  startHeld?: boolean;
  pass(): Promise<void>;
  log(line: string): void;
}

// One admission check and one recovery flight. Durable pause belongs to Operator;
// transient holds and close belong here, never to the stored owner's controls.
export function openSchedulingGate(host: SchedulingGateHost) {
  let closed = false;
  let inflight: Promise<void> | undefined;
  let initialHold = host.startHeld === true;
  let holds = initialHold ? 1 : 0;
  const logged = new WeakSet<Promise<void>>();
  const run = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (inflight) return inflight;
    inflight = Promise.resolve().then(() => host.pass()).finally(() => { inflight = undefined; });
    return inflight;
  };
  const observe = async (pass: Promise<void>): Promise<void> => {
    try { await pass; }
    catch (error) {
      if (!logged.has(pass)) {
        logged.add(pass);
        host.log(`recovery: ${String(error)}`);
      }
    }
  };
  // Joining an older pass cannot guarantee it observed the caller's change.
  const fresh = async (): Promise<void> => {
    const joined = inflight;
    await observe(run());
    if (joined) await observe(run());
  };
  const releaseHold = (): (() => Promise<void>) => {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      holds--;
      await fresh();
    };
  };
  const releaseInitial = releaseHold();
  return {
    mayStart: async (): Promise<boolean> => {
      if (closed || holds) return false;
      const state = await host.read.snapshot(Operator, host.context);
      return !(closed || holds || state?.paused);
    },
    hold: (): (() => Promise<void>) => {
      if (closed) throw new Error("the agent is closed");
      holds++;
      return releaseHold();
    },
    releaseInitial: async (): Promise<void> => {
      if (!initialHold) return;
      initialHold = false;
      await releaseInitial();
    },
    run, fresh,
    settled: (): Promise<void> => inflight ?? Promise.resolve(),
    close: async (): Promise<void> => {
      closed = true;
      await inflight?.catch(() => {});
    },
  };
}
