import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { eventProblem } from "./event.js";
import type { MarketEvent } from "./types.js";

export interface PumpOptions {
  // taskfast CLI binary, 0.19.0 or later (needs `events stream --ack-stdin`).
  taskfastBin: string;
  // Passed through as --env. Omitted means the CLI's own default: production.
  env?: "prod" | "staging" | "local";
  // The CLI's whole environment when given (e.g. PATH, HOME, TASKFAST_CONFIG);
  // otherwise it inherits this process's environment.
  cliEnv?: NodeJS.ProcessEnv;
  // Hands one event to the agent. Resolve only once the event is stored durably:
  // the pump acks after this resolves, and the server then forgets the event.
  deliver(event: MarketEvent): Promise<void>;
  // Receives an event the pump gives up on, before it is acked so the stream can move
  // on: one that fails the event rule, or whose delivery failed maxAttempts times.
  // Keep it somewhere durable; once acked, the server no longer holds it. If it
  // throws, the event is not acked and the stream is stopped, so the server keeps
  // the event. Without it, such events are logged in full and acked.
  deadLetter?(line: string, reason: string): void;
  // Deliveries of one event before it is dead-lettered (default 5). The server
  // re-pushes an unacked event after its ack timeout (default 300 s).
  maxAttempts?: number;
  // A deliver() still pending after this counts as a failed attempt (default 60 s),
  // so a call that never settles cannot hold the stream. If it completes later, the
  // re-pushed copy is dropped by the agent's dedupe.
  deliverTimeoutMs?: number;
  // Failure counts by event id. runEventPumpForever passes one map to every child, so
  // a restart does not reset an event's attempts.
  failures?: Map<string, number>;
  // A child that prints nothing for this long is killed so the caller can restart it
  // (default 10 min). A quiet but healthy stream only pays a reconnect, and the
  // server replays anything unacked.
  idleRestartMs?: number;
  log?(line: string): void;
  signal?: AbortSignal;
}

// `events stream --ack-stdin` arrived in taskfast-cli 0.19.0 (taskfast-cli#169). An
// older CLI rejects the flag and every stream exits at once, so check before pumping.
export function assertPumpCli(bin: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = "";
  try {
    out = execFileSync(bin, ["--version"], { encoding: "utf8", env }).trim();
  } catch (e) {
    throw new Error(`cannot run ${bin} --version: ${e instanceof Error ? e.message : String(e)}`);
  }
  const m = /^taskfast (\d+)\.(\d+)\.(\d+)/.exec(out);
  if (!m) throw new Error(`cannot read a taskfast version from ${JSON.stringify(out.slice(0, 80))}`);
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major === 0 && minor < 19) throw new Error(`taskfast ${m.slice(1).join(".")} is older than 0.19.0, which added events stream --ack-stdin`);
  return m.slice(1).join(".");
}

// Runs one `taskfast events stream --ack-stdin` child for one agent until the
// signal aborts or the child exits. The server pushes one event at a time and holds
// the rest until that one is acked, so events are delivered in order and each is
// acked only after deliver() resolves. A failed deliver() is not acked: the server
// re-pushes the same event after its ack timeout, and after maxAttempts the event is
// dead-lettered and acked, so one undeliverable event cannot park the stream.
// Returns the child's exit code.
export function runEventPump(opts: PumpOptions): Promise<number | null> {
  const o = guarded(opts);
  const args = ["events", "stream", "--ack-stdin", ...(o.env ? ["--env", o.env] : [])];
  const child = spawn(o.taskfastBin, args, {
    env: o.cliEnv ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    signal: o.signal,
  });
  const log = o.log;
  child.stderr.on("data", (b: Buffer) => log(`stderr: ${b.toString().trimEnd()}`));
  let idle: NodeJS.Timeout | undefined;
  const resetIdle = () => {
    clearTimeout(idle);
    const ms = o.idleRestartMs ?? 600_000;
    idle = setTimeout(() => {
      log(`no output for ${ms}ms, restarting the stream`);
      child.kill();
    }, ms);
  };
  resetIdle();
  child.stdin.on("error", () => {}); // the child may exit while an ack is in flight

  // Lines are handled one after another, so a slow deliver() never reorders acks.
  const failures = o.failures ?? new Map<string, number>();
  let chain = Promise.resolve();
  createInterface({ input: child.stdout }).on("line", (line) => {
    resetIdle();
    chain = chain.then(() => handle(line, o, child.stdin, failures, () => child.kill())).catch((e) => log(`line handling failed: ${e instanceof Error ? e.message : String(e)}`));
  });

  return new Promise((resolve) => {
    child.on("error", (e) => {
      if (e.name !== "AbortError") log(`spawn failed: ${e.message}`);
    });
    // On abort, settle at once: the child is already killed, and a pending line would
    // otherwise hold shutdown for up to deliverTimeoutMs.
    child.on("close", (code) => {
      clearTimeout(idle);
      if (o.signal?.aborted) resolve(code);
      else void chain.then(() => resolve(code));
    });
  });
}

// The caller's callbacks with every throw contained, so neither can break the line
// chain, withhold an ack or stop the restart loop. Each entry point calls this first;
// everything below takes the Guarded shape and never sees a raw callback. Wrap only
// raw options: a second wrap would turn the inner false into true.
// deadLetter returns whether the sink took the event.
type Guarded<T extends PumpOptions = PumpOptions> = Omit<T, "log" | "deadLetter"> & { log(line: string): void; deadLetter(line: string, reason: string): boolean };
function guarded<T extends PumpOptions>(o: T): Guarded<T> {
  const log = (l: string) => {
    try {
      o.log?.(l);
    } catch {}
  };
  const deadLetter = (line: string, reason: string) => {
    try {
      o.deadLetter?.(line, reason);
      return true;
    } catch (e) {
      log(`dead-letter sink failed (${e instanceof Error ? e.message : String(e)}), dropping (${reason}): ${line}`);
      return false;
    }
  };
  return { ...o, log, deadLetter };
}

// Keeps a pump running until the signal aborts. The CLI reconnects dropped sockets
// itself, so this covers the process going away (crash, bad key). The delay doubles
// on each quick exit up to maxDelayMs, and resets after a stream that stayed up.
export async function runEventPumpForever(opts: PumpOptions & { signal: AbortSignal; minDelayMs?: number; maxDelayMs?: number }): Promise<void> {
  const { log } = guarded(opts);
  const o = opts;
  const min = o.minDelayMs ?? 5_000;
  const max = o.maxDelayMs ?? 300_000;
  let delay = min;
  const failures = new Map<string, number>();
  while (!o.signal.aborted) {
    const started = Date.now();
    // The raw options: runEventPump wraps them itself.
    const code = await runEventPump({ ...opts, failures });
    if (o.signal.aborted) return;
    if (Date.now() - started > max) delay = min;
    log(`stream exited with ${code}, restarting in ${delay}ms`);
    await sleep(delay, undefined, { signal: o.signal }).catch(() => {});
    delay = Math.min(delay * 2, max);
  }
}

async function handle(line: string, o: Guarded, stdin: NodeJS.WritableStream, failures: Map<string, number>, stop: () => void): Promise<void> {
  const log = o.log;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    msg = undefined;
  }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return log(`not a JSON object, skipped: ${line.slice(0, 200)}`);
  const m = msg as Record<string, unknown>;
  if (typeof m.sentinel === "string") return log(`sentinel ${m.sentinel}`);
  // An id with a line break cannot be acked safely; treat it as having no id.
  const id = typeof m.event_id === "string" && m.event_id && !/[\r\n]/.test(m.event_id) ? m.event_id : null;
  // The ack waits on the sink. If the sink could not store the event, it stays
  // unacked and the stream is stopped: the server keeps the event, and the caller's
  // restart loop retries the sink with backoff instead of losing the only copy.
  const giveUp = (reason: string) => {
    if (!o.deadLetter(line, reason)) {
      log(`not acking ${id}: dead-letter sink failed; stopping the stream`);
      return stop();
    }
    log(`dead-lettered ${id}: ${reason}`);
    failures.delete(id!);
    stdin.write(`${id}\n`);
  };
  // The same rule MarketplaceAgent.deliver applies. Without an id there is nothing the server
  // could be holding for us to ack; with one, the event can never be stored, so it is
  // dead-lettered rather than left to stall the stream.
  const problem = eventProblem(m);
  if (problem) return id ? giveUp(problem) : log(`${problem}, skipped: ${line.slice(0, 200)}`);
  let timer: NodeJS.Timeout | undefined;
  try {
    const limit = o.deliverTimeoutMs ?? 60_000;
    await Promise.race([
      o.deliver(m as unknown as MarketEvent),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${limit}ms`)), limit))),
    ]);
  } catch (e) {
    const n = (failures.get(id!) ?? 0) + 1;
    const why = e instanceof Error ? e.message : String(e);
    if (n >= (o.maxAttempts ?? 5)) return giveUp(`delivery failed ${n} times: ${why}`);
    failures.set(id!, n);
    return log(`deliver ${id} failed (${n}), not acked: ${why}`);
  } finally {
    clearTimeout(timer);
  }
  failures.delete(id!);
  stdin.write(`${id}\n`);
}
