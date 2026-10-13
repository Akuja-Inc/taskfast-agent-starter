import { dirname, join } from "node:path";
import { cliEnv, taskfastBin } from "./cli.js";
import { appendJsonl } from "./jsonl.js";
import { assertPumpCli, runEventPumpForever } from "./pump.js";
import type { MarketEvent, Runtime } from "./types.js";

// The host owns the stream for the same lifetime as the agent's store. Admission
// commits locally and resolves before the pump ACKs; model execution is independent.
export function startListener(o: {
  runtime: Runtime;
  deliver(event: MarketEvent): Promise<void>;
  log(line: string): void;
}): { close(): Promise<void> } {
  assertPumpCli(taskfastBin(), cliEnv(o.runtime));
  const stop = new AbortController();
  const running = runEventPumpForever({
    taskfastBin: taskfastBin(), env: o.runtime.env, cliEnv: cliEnv(o.runtime),
    signal: stop.signal, deliver: o.deliver,
    deadLetter: (line, reason) => appendJsonl(join(dirname(o.runtime.configPath), "dead-letter.jsonl"), { at: new Date().toISOString(), reason, line }),
    log: o.log,
  });
  return { close: async () => { stop.abort(); await running; } };
}
