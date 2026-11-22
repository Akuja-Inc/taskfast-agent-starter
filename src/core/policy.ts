import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, ROOT_CONVERSATION_ID, type Conversation, type DocumentReader, type Tx } from "@earendil-works/pi-durable";
import { runCli, type CliResult, type Outcome } from "./cli.js";
import { agentDirectory } from "./folder.js";
import { clearOwnUploads, materializeArtifacts, type ResolvedFile } from "./artifacts.js";
import { amountOf, reserve, recheck, settle, today, type Action, type Ledger } from "./money.js";
import { addNote, removeNote } from "./notes.js";
import { FROZEN, Operator } from "./operator.js";
import { prepare, UUID } from "./tools.js";
import type { AgentSpec, Json, Runtime } from "./types.js";

type PolicyState = Ledger & {
  identity: { env: Runtime["env"]; agentId: string } | null;
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
export type Command = (runtime: Runtime, args: string[], files?: ResolvedFile[]) => Promise<CliResult>;
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
      const { spec, args, key, files, input } = prepare(tool, value);
      if (spec.kind === "memory") {
        return commit(async (tx): Promise<Json> => {
          const state = await tx.doc(Policy);
          if (tool === "remember") addNote(state.memory, input.note as string);
          // Notes number from 1, as the prompt shows them.
          else removeNote(state.memory, input.index as number);
          return { ok: true };
        });
      }
      if (spec.kind === "read") {
        const result = await command(o.runtime, args);
        return result.outcome === "ok" ? result.data ?? null : { error: result.error ?? result.outcome };
      }
      if (!key) throw new Error(`write ${tool} has no action key`);
      const state = await snapshot();
      const prior = state.actions[key];
      if (prior && prior.status !== "failed") return skipped(prior);
      let resolved: ResolvedFile[] = [];
      if (files.length) {
        try { resolved = materializeArtifacts(agentDirectory(o.runtime), files); }
        catch (error) { return { refused: `could not write the artifact files: ${error instanceof Error ? error.message : String(error)}` }; }
      }
      // A submit can upload and then be refused (criteria unmet), and the CLI reports a
      // refusal, so a resubmit would pile copies on the task. On a task still being
      // submitted every upload of ours is such a leftover: delete them first.
      if (spec.delivery === "submit" && files.length) {
        const cleared = await clearOwnUploads(input.task_id as string, state.identity!.agentId, async (args) => {
          // Cleanup is repeat-safe, but each delete is still a write. The invocation's
          // bound commit rejects durable abort marks and closure before dispatch.
          if (args[1] === "delete") {
            await commit(async () => {});
            signal?.throwIfAborted();
          }
          return command(o.runtime, args);
        });
        if (cleared) return { refused: cleared };
      }
      const read = (args: string[]) => command(o.runtime, args);
      const amount = spec.kind === "money" ? await amountOf(spec.amount, input, read) : 0;
      if (typeof amount === "string") return { refused: amount };
      // Only money tools carry the owner's limits into the ledger transitions.
      const limits = spec.kind === "money" ? o.spec.limits : undefined;
      // reserve: reservation and funds are atomic and durably committed BEFORE dispatch.
      const refusal = await commit(async (tx): Promise<Json> => {
        const state = await tx.doc(Policy);
        const prior = state.actions[key];
        if (prior && prior.status !== "failed") return skipped(prior);
        if (spec.kind === "money" && (await tx.doc(Operator)).frozen) return { refused: FROZEN };
        const over = reserve(state, key, { amount, limits, day: today(now()), at: now().toISOString() });
        return over ? { refused: over } : null;
      });
      if (refusal !== null) return refusal;
      // recheck: check again at dispatch, including midnight rollover. The reservation
      // is already counted, so recheck excludes this action while testing its own limit.
      const over = await commit(async (tx) => {
        const state = await tx.doc(Policy);
        return recheck(state, key, { limits, day: today(now()) });
      });
      if (over) return { refused: over };
      // Pi owns this invocation. An abort/close after the server reads may revoke
      // it before dispatch; bound commits also reject durable abort marks.
      signal?.throwIfAborted();
      let result: CliResult;
      try { result = await command(o.runtime, args, resolved.length ? resolved : undefined); }
      catch (error) { result = { outcome: "uncertain", error: error instanceof Error ? error.message : String(error) }; }
      // A money tool that can spend after its own preflight has no failure the kit can
      // call known: the CLI may have signed before it refused, so a failure that would
      // otherwise release the money stays uncertain and never repeats.
      const outcome: Outcome = result.outcome === "failed" && spec.kind === "money" && spec.spendAfterPreflight === true ? "uncertain" : result.outcome;
      // settle: the ledger records the outcome; only a refusal releases the money.
      await commit(async (tx) => {
        const state = await tx.doc(Policy);
        settle(state, key, outcome, now().toISOString());
      });
      return outcome === "ok" ? result.data ?? null : { [outcome]: result.error ?? "" };
    });
  }
  return { initialize, execute, snapshot };
}
export type MarketplacePolicy = ReturnType<typeof marketplacePolicy>;
