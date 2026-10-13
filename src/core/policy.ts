import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, ROOT_CONVERSATION_ID, type Conversation, type DocumentReader, type Tx } from "@earendil-works/pi-durable";
import { runCli, type CliResult } from "./cli.js";
import { amountOf, overLimit, today } from "./money.js";
import { FROZEN, Operator } from "./operator.js";
import { prepare, UUID } from "./tools.js";
import type { AgentSpec, Json, Runtime } from "./types.js";

export type Action = {
  status: "reserved" | "done" | "failed" | "uncertain";
  at: string;
  amount: number;
  day: string;
};
type PolicyState = {
  identity: { env: Runtime["env"]; agentId: string } | null;
  actions: Record<string, Action>;
  spend: Record<string, number>;
  memory: string[];
};

// Session-scoped: neither resets nor compaction nor a new conversation can rewind
// marketplace identity or daily commitments. Entries are never evicted.
// No migration: a version 1 path-bound ledger must be rejected, never reset.
export const Policy = defineDoc<PolicyState>({
  kind: "taskfast.policy", version: 2, scope: "session",
  initial: () => ({ identity: null, actions: {}, spend: {}, memory: [] }),
});
const context = BACKGROUND_CONTEXT;
export type Command = (runtime: Runtime, args: string[]) => Promise<CliResult>;
export interface PolicyOptions {
  conversation: Conversation;
  read: DocumentReader;
  spec: AgentSpec;
  runtime: Runtime;
  command?: Command;
  now?: () => Date;
}

// Command unwraps the CLI envelope; me's data.profile.id is the stable account
// binding. Treat even successful external data as unknown until validated.
function agentIdentity(data: unknown): string {
  if (typeof data !== "object" || data === null || !("profile" in data)) throw new Error("me must return a TaskFast agent profile UUID");
  const profile = data.profile;
  if (typeof profile !== "object" || profile === null || !("id" in profile) || typeof profile.id !== "string" || !UUID.test(profile.id)) {
    throw new Error("me must return a TaskFast agent profile UUID");
  }
  return profile.id.toLowerCase();
}

function skipped(prior: Action): Json {
  return { skipped: prior.status === "done" ? "already done" : "outcome unknown; read the current state", at: prior.at };
}

export function marketplacePolicy(o: PolicyOptions) {
  const command = o.command ?? runCli;
  const now = o.now ?? (() => new Date());
  const commit = <T>(change: (tx: Tx) => Promise<T>) => o.conversation.commit(change, context);
  // Pi serializes a tool round, not all conversations. Keep admission and dispatch
  // together within this store too, including callers outside the model.
  let tail: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work);
    tail = next.catch(() => {});
    return next;
  }
  async function snapshot() {
    const state = await o.read.snapshot(Policy, context);
    if (!state?.identity) throw new Error("marketplace policy is not initialized");
    return state;
  }
  async function initialize(): Promise<void> {
    const result = await command(o.runtime, ["me"]);
    if (result.outcome !== "ok") throw new Error("cannot establish TaskFast agent identity from me");
    const agentId = agentIdentity(result.data);
    await commit(async (tx) => {
      const state = await tx.doc(Policy);
      if (state.identity && (state.identity.env !== o.runtime.env || state.identity.agentId !== agentId)) {
        throw new Error("agent store belongs to another TaskFast account or environment");
      }
      state.identity = { env: o.runtime.env, agentId };
      for (const action of Object.values(state.actions)) {
        // No local dispatch permit survives reopening. Its amount was already
        // committed when reserved, even if the CLI never started.
        if (action.status === "reserved") action.status = "uncertain";
      }
    });
  }
  async function execute(call: {
    tool: string;
    input: unknown;
    commit<T>(change: (tx: Tx) => Promise<T>): Promise<T>;
    signal?: AbortSignal;
  }): Promise<Json> {
    const { tool, input: value, commit, signal } = call;
    return serialized(async () => {
      signal?.throwIfAborted();
      if (o.conversation.id !== ROOT_CONVERSATION_ID) throw new Error("only the root marketplace conversation may act");
      const { spec, args, key, input } = prepare(tool, value);
      if (spec.kind === "memory") {
        return commit(async (tx): Promise<Json> => {
          const state = await tx.doc(Policy);
          if (tool === "remember") {
            state.memory.push(input.note as string);
          } else {
            state.memory = state.memory.filter((_, index) => index !== input.index);
          }
          return { ok: true };
        });
      }
      if (spec.kind === "read") {
        const result = await command(o.runtime, args);
        return result.outcome === "ok" ? result.data ?? null : { error: result.error ?? result.outcome };
      }
      if (!key) throw new Error(`write ${tool} has no action key`);
      const prior = (await snapshot()).actions[key];
      if (prior && prior.status !== "failed") return skipped(prior);
      const read = (args: string[]) => command(o.runtime, args);
      const amount = spec.kind === "money" ? await amountOf(spec.amount, input, read) : 0;
      if (typeof amount === "string") return { refused: amount };
      const refusal = await commit(async (tx): Promise<Json> => {
        const state = await tx.doc(Policy);
        const prior = state.actions[key];
        if (prior && prior.status !== "failed") return skipped(prior);
        if (spec.kind === "money" && (await tx.doc(Operator)).frozen) return { refused: FROZEN };
        const day = today(now());
        const over = overLimit(o.spec.limits, state.spend[day] ?? 0, amount);
        if (over && spec.kind === "money") return { refused: over };
        // Reservation and funds are atomic and durably committed BEFORE dispatch.
        state.actions[key] = { status: "reserved", at: now().toISOString(), amount, day };
        state.spend[day] = (state.spend[day] ?? 0) + amount;
        return null;
      });
      if (refusal !== null) return refusal;
      // Check again at dispatch, including midnight rollover. The reservation is
      // already counted, so exclude this action while testing its own limit.
      const over = await commit(async (tx) => {
        const state = await tx.doc(Policy);
        const action = state.actions[key];
        const day = today(now());
        const other = (state.spend[day] ?? 0) - (action.day === day ? amount : 0);
        const refused = spec.kind === "money" ? overLimit(o.spec.limits, other, amount) : null;
        if (refused) {
          state.spend[action.day] -= amount;
          action.status = "failed";
          return refused;
        }
        if (action.day !== day) {
          state.spend[action.day] -= amount;
          state.spend[day] = (state.spend[day] ?? 0) + amount;
          action.day = day;
        }
        return null;
      });
      if (over) return { refused: over };
      // Pi owns this invocation. An abort/close after the server reads may revoke
      // it before dispatch; bound commits also reject durable abort marks.
      signal?.throwIfAborted();
      let result: CliResult;
      try { result = await command(o.runtime, args); }
      catch (error) { result = { outcome: "uncertain", error: error instanceof Error ? error.message : String(error) }; }
      await commit(async (tx) => {
        const state = await tx.doc(Policy);
        const action = state.actions[key];
        action.status = result.outcome === "ok" ? "done" : result.outcome;
        action.at = now().toISOString();
        if (result.outcome === "failed") state.spend[action.day] -= action.amount;
      });
      return result.outcome === "ok" ? result.data ?? null : { [result.outcome]: result.error ?? "" };
    });
  }
  return { initialize, execute, snapshot };
}
export type MarketplacePolicy = ReturnType<typeof marketplacePolicy>;
