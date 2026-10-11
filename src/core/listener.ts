import { dirname, join } from "node:path";
import { cliEnv, taskfastBin } from "./cli.js";
import { appendJsonl } from "./jsonl.js";
import { runEventPumpForever } from "./pump.js";
import { selfActor } from "./self.js";
import type { Runtime } from "./types.js";

// The actor's ears: one `taskfast events stream --ack-stdin` per actor in this worker,
// started from inside the actor. Each event goes back to the actor as its own call
// (deliver), and is acked only after that call commits. The handle lives here, not in
// an actor field: the runtime cannot persist a process, and a new worker starts with
// no listener, which the next call to the actor re-arms.
const listeners = new Map<string, AbortController>();

export function ensureListener(id: string, rt: Runtime, log: (l: string) => void = (l) => console.error(`${id}: ${l}`)): boolean {
  const cur = listeners.get(id);
  if (cur && !cur.signal.aborted) return false;
  const ctl = new AbortController();
  listeners.set(id, ctl);
  void runEventPumpForever({
    taskfastBin: taskfastBin(),
    env: rt.env,
    cliEnv: cliEnv(rt),
    signal: ctl.signal,
    deliver: async (e) => (await selfActor(id)).deliver(e),
    deadLetter: (line, reason) => appendJsonl(join(dirname(rt.configPath), "dead-letter.jsonl"), { at: new Date().toISOString(), reason, line }),
    log,
  }).finally(() => {
    if (listeners.get(id) === ctl) listeners.delete(id);
  });
  return true;
}

export function stopListener(id: string): void {
  listeners.get(id)?.abort();
  listeners.delete(id);
}

export const listening = (id: string): boolean => listeners.has(id);
