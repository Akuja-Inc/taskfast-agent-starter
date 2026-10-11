import { randomUUID } from "node:crypto";
import { Actor, Persisted } from "durable-actors";
import { runCli } from "./cli.js";
import { counterpartyRefusal, parseCounterparties } from "./counterparty.js";
import { eventProblem } from "./event.js";
import { ensureListener } from "./listener.js";
import { account, authorize, recheck } from "./money.js";
import { languageModel } from "./model.js";
import { selfActor } from "./self.js";
import { parseAgentSpec } from "./spec.js";
import { prepare } from "./tools.js";
import { clip, decideNext } from "./turn.js";
import { ENVS, type ActionRecord, type AgentSpec, type Json, type MarketEvent, type Pending, type Runtime, type Spend, type Turn } from "./types.js";

// Event ids remembered for dedupe. The stream is at-least-once: an event can come
// again if the listener stops between deliver() and its ack.
const SEEN = 256;

// Steps queued in this worker and not yet started, by actor id. Not persisted: after
// a worker restart nothing is queued, and ping() re-queues (transition 16).
const queued = new Set<string>();

// One actor per agent, keyed by the caller's id. It listens to its own event stream,
// lets the model decide, and runs its own taskfast commands, one committed call per
// step. Rows in comments refer to the PR2b transition table.
//
// Every method on this class is reachable over the runtime API, and the runtime
// requires all of them to be async, so the internal steps are module functions below,
// not methods. Outside code is meant to call only init() and ping().
export class Persona extends Actor {
  @Persisted spec: AgentSpec | null = null;
  @Persisted runtime: Runtime | null = null;
  @Persisted inbox: MarketEvent[] = [];
  @Persisted seen: string[] = [];
  @Persisted turn: Turn | null = null;
  @Persisted pending: Pending | null = null;
  @Persisted actions: { [key: string]: ActionRecord } = {};
  @Persisted memory: string[] = [];
  @Persisted spend: Spend = { day: "", usd: 0 };

  // L1. Everything is validated here, since callers reach it over the runtime API.
  async init(spec: AgentSpec, runtime: Runtime): Promise<void> {
    const parsed = parseAgentSpec(spec);
    if (!runtime || !ENVS.includes(runtime.env)) throw new Error(`runtime.env must be one of ${ENVS.join(", ")}`);
    if (typeof runtime.configPath !== "string" || !runtime.configPath.startsWith("/")) throw new Error("runtime.configPath must be an absolute path");
    const counterparties = runtime.counterparties === undefined ? undefined : parseCounterparties(runtime.counterparties);
    this.spec = parsed;
    this.runtime = { env: runtime.env, configPath: runtime.configPath, ...(counterparties ? { counterparties } : {}) };
    listen(this, this.id);
  }

  // 1 and 3. Stores one event, then wakes the actor unless a turn is already running
  // (a running turn picks new events up when it closes). This relies on the runtime
  // running one call per actor at a time, across awaits: a deliver() sent while a
  // step() awaits the model runs only after that step commits (checked in the real
  // runtime, 2026-10-10). Do not add @Interleave to this class.
  // The listener acks the event once this commits.
  async deliver(event: MarketEvent): Promise<void> {
    const problem = eventProblem(event);
    if (problem) throw new Error(`event refused: ${problem}`);
    listen(this, this.id);
    if (this.seen.includes(event.event_id)) return;
    this.inbox = [...this.inbox, event];
    this.seen = [...this.seen, event.event_id].slice(-SEEN);
    if (!this.turn && !this.pending) queueStep(this, this.id);
  }

  // 2 and 16, plus L2. The outside world's only nudge: re-arm the listener, wake an
  // idle actor, and restart a chain whose queued step was lost.
  async ping(): Promise<void> {
    ready(this);
    listen(this, this.id);
    if (!queued.has(this.id)) queueStep(this, this.id);
  }

  // 4-11. One committed step of a turn. token is set only on the call queued to run
  // a write that the previous step armed.
  async step(token = ""): Promise<void> {
    const id = this.id;
    queued.delete(id);
    const { spec, runtime } = ready(this);
    listen(this, id);
    if (this.pending) return act(this, id, runtime, token);
    // A queued step always means "think now": a new event, a ping, or the next step of
    // an open turn. Whether to wake is decided from the turn and pending action only.

    const turn = this.turn ?? { id: randomUUID(), startedAt: new Date().toISOString(), inboxIds: this.inbox.map((e) => e.event_id), transcript: [] };
    const events = this.inbox.filter((e) => turn.inboxIds.includes(e.event_id));
    // 4, 5, 6. A model error throws here and the whole call rolls back (I5).
    const d = await decideNext(languageModel(spec.model), { spec, memory: this.memory, events, transcript: turn.transcript });
    if (d.type === "end") return closeTurn(this, id, turn);
    try {
      prepare(d.tool, d.input);
      this.turn = turn;
      this.pending = { tool: d.tool, input: d.input, status: "decided" };
    } catch (e) {
      this.turn = { ...turn, transcript: [...turn.transcript, { tool: d.tool, input: d.input, result: { refused: message(e) } }] };
    }
    queueStep(this, id);
  }

  // A read-only view for operators and tests.
  async status(): Promise<{ stepQueued: boolean; turnOpen: boolean; pending: Pending | null; inbox: number; actions: number; memory: number }> {
    return { stepQueued: queued.has(this.id), turnOpen: this.turn !== null, pending: this.pending, inbox: this.inbox.length, actions: Object.keys(this.actions).length, memory: this.memory.length };
  }
}

async function act(a: Persona, id: string, runtime: Runtime, token: string): Promise<void> {
  const p = a.pending!;
  const { spec, args, key, input } = prepare(p.tool, p.input);
  if (spec.kind === "memory") {
    const input = p.input as { note?: string; index?: number };
    if (p.tool === "remember" && typeof input.note === "string") a.memory = [...a.memory, input.note];
    if (p.tool === "forget" && typeof input.index === "number") a.memory = a.memory.filter((_, i) => i !== input.index);
    return finish(a, id, { ok: true });
  }
  if (spec.kind === "read") {
    // 7. Reads are safe to repeat, so they run as soon as they are reached.
    const r = await runCli(runtime, args);
    return finish(a, id, r.outcome === "ok" ? (r.data ?? null) : { error: r.error ?? r.outcome });
  }
  // 8. Already done, or possibly done (uncertain), for this key: never run again (I1).
  // Only a refused write (failed: the CLI refused before acting) may be tried again.
  const prior = a.actions[key!];
  if (prior && prior.status !== "failed") {
    const why = prior.status === "done" ? "already done" : "an earlier attempt's outcome is unknown, so it is not repeated; read the current state";
    return finish(a, id, { skipped: why, at: prior.at });
  }
  if (p.status === "decided") {
    // 13a. When the host limits whom this agent deals with, the write's other side must
    // be on that list. A refusal is not recorded, so a later allowed attempt can run.
    if (runtime.counterparties && spec.party) {
      const refused = await counterpartyRefusal(spec.party, input, runtime.counterparties, (args) => runCli(runtime, args));
      if (refused) return finish(a, id, { refused });
    }
    // 12a. A money tool's amount is fixed by code here, and checked against the
    // agent's own limits before anything can run.
    let amount: number | undefined;
    if (spec.kind === "money") {
      const ok = await authorize(spec.amount, input, a.spec!.limits, a.spend, (args) => runCli(runtime, args));
      if ("refused" in ok) return finish(a, id, ok);
      amount = ok.amount;
    }
    // 9. Commit "executing" first; the write runs in the next call.
    const armedBy = randomUUID();
    a.pending = { ...p, status: "executing", armedBy, ...(amount !== undefined ? { amount } : {}) };
    return queueStep(a, id, armedBy);
  }
  if (token && token === p.armedBy) {
    // 12b. Limits checked again just before money moves (I2).
    if (spec.kind === "money") {
      const over = recheck(p.amount, a.spec!.limits, a.spend);
      if (over) return finish(a, id, { refused: over });
    }
    // 10. The one call allowed to run this write.
    const r = await runCli(runtime, args);
    const status = r.outcome === "ok" ? "done" : r.outcome;
    record(a, key!, status);
    if (spec.kind === "money") a.spend = account(a.spend, p.amount!, status);
    return finish(a, id, status === "done" ? (r.data ?? null) : { [status]: r.error ?? "" });
  }
  // 11. Found executing by any other call: the write may or may not have run.
  record(a, key!, "uncertain");
  if (spec.kind === "money" && p.amount !== undefined) a.spend = account(a.spend, p.amount, "uncertain");
  return finish(a, id, { uncertain: "outcome unknown: read the current state before trying again" });
}

// Closes a step: result into the turn, pending cleared, next step queued.
function finish(a: Persona, id: string, result: Json): void {
  const p = a.pending!;
  const turn = a.turn!;
  a.turn = { ...turn, transcript: [...turn.transcript, { tool: p.tool, input: p.input, result: clip(result) }] };
  a.pending = null;
  queueStep(a, id);
}

// 5. Remove only the events this turn was shown (I3); wake again if more arrived.
function closeTurn(a: Persona, id: string, turn: Turn): void {
  a.inbox = a.inbox.filter((e) => !turn.inboxIds.includes(e.event_id));
  a.turn = null;
  if (a.inbox.length) queueStep(a, id);
}

// The once-only ledger: one entry per write this actor has made, never evicted, so a
// completed write can never run again however long the actor lives.
function record(a: Persona, key: string, status: ActionRecord["status"]): void {
  a.actions = { ...a.actions, [key]: { status, at: new Date().toISOString() } };
}

// Queues this actor's next step. The queued call runs after the current one commits;
// one queued step per actor at a time (I4). A write's armed step always queues.
function queueStep(_a: Persona, id: string, token = ""): void {
  if (queued.has(id) && !token) return;
  queued.add(id);
  void selfActor(id)
    .then((s) => s.step(token))
    .catch((e) => {
      queued.delete(id);
      console.error(`${id}: step failed: ${message(e)}`);
    });
}

function listen(a: Persona, id: string): void {
  if (a.runtime) ensureListener(id, a.runtime);
}

function ready(a: Persona): { spec: AgentSpec; runtime: Runtime } {
  if (!a.spec || !a.runtime) throw new Error("agent not initialised");
  return { spec: a.spec, runtime: a.runtime };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The methods a host calls on a Persona over the runtime API.
export type PersonaActor = Pick<Persona, "init" | "deliver" | "ping">;
