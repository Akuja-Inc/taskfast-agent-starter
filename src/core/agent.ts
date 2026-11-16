import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, StringEnum, type Message, type Models, type TSchema } from "@earendil-works/pi-ai";
import * as piDurable from "@earendil-works/pi-durable";
import { parseWalletPasswordFile } from "./cli.js";
import { createRegistry, defineExtension, defineTool, section, ROOT_CONVERSATION_ID, type Conversation, type SessionEnd, type Storage, type ToolRegistration } from "@earendil-works/pi-durable";
import { openEventWork, type EventWork } from "./events.js";
import { openSchedulingGate } from "./gate.js";
import { createAgentModels } from "./model.js";
import { addNote, removeNote, replaceNote } from "./notes.js";
import { agentDirectory, providerSettings } from "./folder.js";
import { initialOperator, openOperatorQueue, Operator, type OperatorState, type QueuedOperatorMessage, type SteerResult, type WithdrawResult } from "./operator.js";
import { marketplacePolicy, Policy, type Command, type MarketplacePolicy } from "./policy.js";
import { marketplacePrompt } from "./prompt.js";
import { connectMcp } from "./mcp.js";
import { CleanupError } from "./cleanup-error.js";
import { loadMcpConfig } from "./mcp-config.js";
import { installCapability } from "./capability.js";
import { loadSkills, skillCapability } from "./skills.js";
import { parseAgentSpec, splitModel } from "./spec.js";
import { openAgentStorage } from "./storage.js";
import { TOOLS } from "./tools.js";
import { ENVS, type AgentSpec, type MarketEvent, type Runtime } from "./types.js";

// The pinned package exports exactly one runtime factory with this public contract.
// Resolve it without borrowing upstream vocabulary reserved by the kit's name scan.
const factories = Object.values(piDurable).filter((value): value is Extract<typeof value, { open: unknown }> =>
  typeof value === "object" && value !== null && "open" in value && typeof value.open === "function",
);
if (factories.length !== 1) throw new Error("unsupported Pi runtime factory exports");
const PiRuntime = factories[0];
type PiEngine = Awaited<ReturnType<typeof PiRuntime.open>>;
const context = BACKGROUND_CONTEXT;
export interface AgentOptions {
  storePath: string;
  spec: AgentSpec;
  runtime: Runtime;
  models?: Models;
  command?: Command;
  now?: () => Date;
  recoverEveryMs?: number;
  // Cancels opening; the returned agent still has its explicit close() lifecycle.
  signal?: AbortSignal;
  // A management reopen validates/commits its registry before scheduling work.
  startHeld?: boolean;
  log?: (line: string) => void;
  // Tests substitute a wrapping opener to inject storage failures.
  openStorage?: (file: string) => Promise<Storage>;
}
export interface MarketplaceAgent {
  conversation: Conversation;
  deliver(event: MarketEvent): Promise<void>;
  ping(): Promise<void>;
  recover(): Promise<void>;
  status(): ReturnType<MarketplacePolicy["snapshot"]>;
  operator: OperatorControls;
  // The newest `limit` stored entries' messages, oldest first.
  transcript(limit: number): Promise<Message[]>;
  // Calls `listener` after every commit to this agent's store; returns the unsubscribe.
  changes(listener: () => void): () => void;
  // Resolves when the Pi session ends: { reason: "closed" } after close(), or
  // { reason: "failed", error } when a storage error failed it. A failed session
  // has already closed its store, so the host must stop the agent without ACKing.
  closed: Promise<SessionEnd>;
  waitForIdle(): Promise<void>;
  // Hold host admissions to Pi while the current work finishes, without changing the
  // owner's durable Pause choice. Cancellation releases the hold, never aborts a write.
  quiesce(signal: AbortSignal): Promise<() => Promise<void>>;
  releaseInitialHold(): Promise<void>;
  // Live transport health is separate from configured tool access and test results.
  capabilityConnections(): { name: string; state: "connected" | "disconnected" }[];
  close(): Promise<void>;
}
// The user's controls, committed to the store before they take effect.
export interface OperatorControls {
  state(): Promise<OperatorState>;
  setFrozen(frozen: boolean): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  // Queues the user's words as the next input; the same requestId is delivered once.
  message(message: { requestId: string; text: string; steer?: true }): Promise<void>;
  queued(): Promise<QueuedOperatorMessage[]>;
  steer(requestId: string): Promise<SteerResult>;
  withdraw(requestId: string): Promise<WithdrawResult>;
  addOrder(order: string): Promise<void>;
  removeOrder(index: number): Promise<void>;
  // The owner's write to the agent's notes: replace or remove the note at `at` when it
  // still holds `expect`, or append when `at` is null. Call it only inside quiesce(), so a
  // turn's numbering never moves under the agent's forget.
  changeNote(at: { index: number; expect: string } | null, text: string | null): Promise<"done" | "changed">;
  // Replaces one order's text in place, in one commit, so no turn runs without it.
  replaceOrder(index: number, order: string): Promise<void>;
  markChecked(id: string): Promise<void>;
  // Admitted marketplace events by `event:<event_id>`, with their run state.
  events(): Promise<Record<string, EventWork>>;
  // One fresh run for an abandoned event; a failure abandons it again.
  retryEvent(eventId: string): Promise<void>;
}

function parameters(schema: typeof TOOLS[string]["schema"]): TSchema {
  const fields: Record<string, TSchema> = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    const value = property.items ? Type.Array(parameters(property.items)) : property.enum ? StringEnum(property.enum) : property.type === "number" ? Type.Number() : Type.String();
    fields[name] = schema.required.includes(name) ? value : Type.Optional(value);
  }
  return Type.Object(fields, { additionalProperties: false });
}
function parseRuntime(runtime: Runtime): Runtime {
  if (!runtime || !ENVS.includes(runtime.env)) throw new Error(`runtime.env must be one of ${ENVS.join(", ")}`);
  if (typeof runtime.configPath !== "string" || !runtime.configPath.startsWith("/")) throw new Error("runtime.configPath must be an absolute path");
  return { env: runtime.env, configPath: runtime.configPath, ...(runtime.walletPasswordFile === undefined ? {} : { walletPasswordFile: parseWalletPasswordFile(runtime.walletPasswordFile) }) };
}
// One store, root conversation and authoritative policy per marketplace agent.
// No coding tools, child work or forks are installed or enabled.
export async function openMarketplaceAgent(o: AgentOptions): Promise<MarketplaceAgent> {
  o.signal?.throwIfAborted();
  const spec = parseAgentSpec(o.spec);
  const runtime = parseRuntime(o.runtime);
  const agentDir = agentDirectory(runtime);
  const models = o.models ?? await createAgentModels(spec.model, { agentDir, settings: providerSettings(agentDir) });
  const log = (line: string) => { try { o.log?.(line); } catch {} };
  const now = () => (o.now?.() ?? new Date()).getTime();
  // A malformed skill throws here, before the store opens or the server is asked anything.
  const skills = loadSkills(agentDir);
  if (skills.length) log(`skills: ${skills.map((skill) => skill.name).join(", ")}`);
  const registry = createRegistry();
  let policy: MarketplacePolicy | undefined;
  const tools: ToolRegistration[] = Object.entries(TOOLS).map(([name, tool]) => defineTool({
    name, description: tool.description, parameters: parameters(tool.schema),
    replay: tool.kind === "read" ? "safe" : "unsafe", executionMode: "sequential",
    execute: async (args, api, ctx) => {
      if (!policy || api.conversationId !== ROOT_CONVERSATION_ID) throw new Error("marketplace policy is unavailable");
      const result = await policy.execute({ tool: name, input: args, commit: (change) => api.commit(change, ctx), signal: ctx.abortSignal });
      return { output: [{ type: "text", text: JSON.stringify(result) }] };
    },
  }));
  registry.install(defineExtension({
    name: "taskfast", tools,
    sections: [section("marketplace", async (input, ctx) => {
      const notes = (await input.read.snapshot(Policy, ctx))?.memory ?? [];
      return marketplacePrompt(spec, notes, (await input.read.snapshot(Operator, ctx))?.orders ?? []);
    }, { tag: false })],
  }));
  // Only an agent with skills gets the reader; Pi answers a stored call to it as unavailable.
  const skillsCap = skillCapability(skills);
  installCapability(registry, skillsCap);
  // Every MCP server is connected and its approved tools checked before the store opens;
  // any failure closes the servers already started and stops this agent. Pi lets a later
  // extension's tool replace an earlier one's of the same name, so every installed name is reserved.
  const mcp = await connectMcp(loadMcpConfig(agentDir), { log, reserved: registry.snapshot().tools().map(({ tool }) => tool.name), agentDir, signal: o.signal });
  const capabilities = [skillsCap, mcp];
  // Every capability closes before the first rejection propagates, the rule mcp.ts's
  // own close follows; Promise.all would stop joining after the first failure.
  const closeCapabilities = async (): Promise<void> => {
    const results = await Promise.allSettled(capabilities.map((cap) => cap.close()));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  };
  let storage: Storage | undefined;
  let pi: PiEngine | undefined;
  try {
    o.signal?.throwIfAborted();
    // MCP tools run outside the marketplace policy: approved reads only, never a TaskFast write.
    installCapability(registry, mcp);
    storage = await (o.openStorage ?? openAgentStorage)(o.storePath);
    o.signal?.throwIfAborted();
    pi = await PiRuntime.open(storage, {
      models, registry, settings: { toolExecution: "sequential", retry: { maxRetries: 3 } },
      conversationCreated: (_tx, conversation) => {
        if (conversation.id !== ROOT_CONVERSATION_ID) throw new Error("marketplace child conversations and forks are disabled");
      },
      onReport: (error) => log(`Pi: ${error instanceof Error ? error.message : String(error)}`),
    }, context);
    const owner = pi;
    const conversation = await owner.root(context, { agent: { model: splitModel(spec.model) } });
    await conversation.configure({ model: splitModel(spec.model) }, context);
    policy = marketplacePolicy({ conversation, read: owner, spec, runtime, command: o.command, now: o.now });
    const activePolicy = policy;
    await activePolicy.initialize();
    const gate = openSchedulingGate({
      read: owner, context, log, startHeld: o.startHeld,
      pass: async () => {
        // Finish withdrawal before any submit() can wake Pi's pre-crash inbox.
        await operatorQueue.recoverSteers();
        await eventWork.advance();
        // Withdrawal may finish while paused; its replacement must wait for resume.
        await operatorQueue.drain();
        if (!(await gate.mayStart())) return;
        owner.resume();
        const stalled = await owner.inspect(context);
        const queued = stalled.submissions.find((item) => item.status === "queued");
        // One resume input per stall: none while an earlier one is still queued or placed.
        if (!stalled.tasks.length && queued && !stalled.submissions.some((item) => item.requestId?.startsWith("resume:")) && await gate.mayStart()) {
          await conversation.submit({ type: "input", requestId: `resume:${queued.id}`, content: "Resume your queued marketplace work after the failed run. Read current state before any write." }, context);
        }
      },
    });
    const operatorQueue = openOperatorQueue({ conversation, read: owner, context, log, maySchedule: gate.mayStart });
    const eventWork = await openEventWork({ conversation, read: owner, context, now, log, maySchedule: gate.mayStart });
    const recover = gate.run;
    async function deliver(event: MarketEvent): Promise<void> {
      // Commit durable admission only. The event pump can ACK immediately; a slow
      // model never holds its socket delivery hostage.
      await eventWork.admit(event);
      void gate.runLogged("event recovery");
    }
    async function ping(): Promise<void> {
      await recover();
      if (!(await gate.mayStart())) return;
      const work = await owner.inspect(context);
      if (work.tasks.length || work.submissions.length || !(await gate.mayStart())) return;
      await conversation.submit({ type: "input", content: `Check your marketplace work in your ${spec.role} role and pursue the goals in your instructions. Read current state before acting; do not repeat uncertain writes.` }, context);
    }
    // Restore admitted events even if the process died before submitting to Pi;
    // retry failed model runs and keep queued inputs progressing without repair.
    await recover();
    const timer = setInterval(() => { void gate.runLogged(); }, o.recoverEveryMs ?? 5000);
    timer.unref();
    const quiesce = async (signal: AbortSignal): Promise<() => Promise<void>> => {
      signal.throwIfAborted();
      const release = gate.hold();
      let onAbort = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new Error("waiting cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      try {
        // Join admissions already in flight before observing idle. No timeout or
        // cancellation path signals Pi or an in-flight marketplace operation.
        await Promise.race([(async () => {
          await gate.settled();
          await operatorQueue.idle();
          await conversation.waitForIdle(context);
        })(), cancelled]);
        signal.throwIfAborted();
        return release;
      } catch (error) { await release(); throw error; }
      finally { signal.removeEventListener("abort", onAbort); }
    };
    const operator: OperatorControls = {
      state: async () => (await owner.snapshot(Operator, context)) ?? initialOperator(),
      setFrozen: async (frozen) => { await conversation.commit(async (tx) => { (await tx.doc(Operator)).frozen = frozen; }, context); },
      setPaused: async (paused) => {
        await conversation.commit(async (tx) => { (await tx.doc(Operator)).paused = paused; }, context);
        if (paused) return;
        await gate.fresh();
      },
      message: async ({ requestId, text, steer }) => {
        await operatorQueue.admit({ requestId, text, steer });
        await gate.fresh();
      },
      queued: operatorQueue.read,
      steer: async (requestId) => {
        const result = await operatorQueue.promote(requestId);
        if (result !== "not_found") await gate.fresh();
        return result;
      },
      withdraw: operatorQueue.withdraw,
      addOrder: async (order) => {
        // Each order renders as one bullet line in the system prompt; collapsing line
        // breaks keeps a multi-line order from forging extra prompt lines.
        await conversation.commit(async (tx) => { (await tx.doc(Operator)).orders.push(order.replace(/[\r\n]+/g, " ")); }, context);
      },
      removeOrder: async (index) => {
        await conversation.commit(async (tx) => {
          const state = await tx.doc(Operator);
          state.orders = state.orders.filter((_, at) => at !== index);
        }, context);
      },
      replaceOrder: async (index, order) => {
        await conversation.commit(async (tx) => {
          const state = await tx.doc(Operator);
          // One prompt line per order, as addOrder keeps it.
          if (index < state.orders.length) state.orders[index] = order.replace(/[\r\n]+/g, " ");
        }, context);
      },
      changeNote: (at, text) => conversation.commit(async (tx) => {
        const state = await tx.doc(Policy);
        if (at && state.memory[at.index] !== at.expect) return "changed" as const;
        // The console counts notes from 0; the prompt numbers them from 1.
        if (!at) addNote(state.memory, text as string);
        else if (text === null) removeNote(state.memory, at.index + 1);
        else replaceNote(state.memory, at.index + 1, text);
        return "done" as const;
      }, context),
      events: eventWork.read,
      retryEvent: async (eventId) => {
        await eventWork.retry(eventId);
        await gate.fresh();
      },
      markChecked: async (id) => { await conversation.commit(async (tx) => { (await tx.doc(Operator)).checked[id] = new Date(now()).toISOString(); }, context); },
    };
    // Stored entries, not the model's context, so turns from before a reset still show.
    async function transcript(limit: number): Promise<Message[]> {
      const page = await conversation.entries({ order: "descending" }, limit, undefined, context);
      return [...page.items].reverse().flatMap((entry) => entry.model ?? []);
    }
    let closing: Promise<void> | undefined;
    return {
      conversation, deliver, ping, recover, status: activePolicy.snapshot, operator, transcript,
      // Every commit, not viewState(): that view skips commits to session documents (operator, policy, events).
      // A throwing listener is Pi's to report through onReport, which logs it.
      changes: (listener) => owner.subscribeCommits(listener),
      closed: owner.closed,
      capabilityConnections: () => capabilities.flatMap((cap) => cap.status()),
      releaseInitialHold: gate.releaseInitial,
      waitForIdle: () => conversation.waitForIdle(context),
      quiesce,
      close: async () => {
        if (closing) return;
        closing = (async () => {
          clearInterval(timer);
          // A recovery still in flight may reject (SessionFailed after a storage
          // error); deliver() and ping() already report it, so closing ignores it
          // and still drains operator admission before releasing ownership.
          await gate.close();
          await operatorQueue.idle();
          // Servers stop even when closing the store fails.
          try { await owner.close(context); }
          finally { await closeCapabilities(); }
        })();
        await closing;
      },
    };
  } catch (error) {
    try {
      try {
        if (pi) await pi.close(context);
        else await storage?.close(context);
      } finally { await closeCapabilities(); }
    } catch (cleanup) { throw new CleanupError(cleanup); }
    throw error;
  }
}
