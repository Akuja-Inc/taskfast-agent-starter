import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, StringEnum, type Message, type Models, type TSchema } from "@earendil-works/pi-ai";
import * as piDurable from "@earendil-works/pi-durable";
import { parseWalletPasswordFile } from "./cli.js";
import { createTimeout } from "retry";
import { createRegistry, defineDoc, defineExtension, defineTool, section, ROOT_CONVERSATION_ID, type Conversation, type SubmissionId, type ToolRegistration } from "@earendil-works/pi-durable";
import { eventProblem } from "./event.js";
import { createAgentModels } from "./model.js";
import { agentDirectory, providerSettings } from "./folder.js";
import { initialOperator, MESSAGE_PREFIX, Operator, type OperatorState } from "./operator.js";
import { marketplacePolicy, Policy, type Command, type MarketplacePolicy } from "./policy.js";
import { marketplacePrompt } from "./prompt.js";
import { parseAgentSpec, splitModel } from "./spec.js";
import { openAgentStorage } from "./storage.js";
import { TOOLS } from "./tools.js";
import { ENVS, type AgentSpec, type Json, type MarketEvent, type Runtime } from "./types.js";

// The pinned package exports exactly one runtime factory with this public contract.
// Resolve it without borrowing upstream vocabulary reserved by the kit's name scan.
const factories = Object.values(piDurable).filter((value): value is Extract<typeof value, { open: unknown }> =>
  typeof value === "object" && value !== null && "open" in value && typeof value.open === "function",
);
if (factories.length !== 1) throw new Error("unsupported Pi runtime factory exports");
const PiRuntime = factories[0];
type PiEngine = Awaited<ReturnType<typeof PiRuntime.open>>;
const context = BACKGROUND_CONTEXT;
export type EventWork = { event: Json; attempt: number } & (
  | { kind: "admitted"; notBefore?: number }
  | { kind: "submitted" | "done" | "abandoned"; submission: SubmissionId }
);
// A failed event run is resubmitted after a jittered exponential delay, at most
// `retries` times, then abandoned. The due time is stored, so restarts keep it.
export const EVENT_RETRY = { retries: 5, factor: 2, minTimeout: 30_000, maxTimeout: 10 * 60_000, randomize: true };
const Events = defineDoc<{ events: Record<string, EventWork> }>({
  kind: "taskfast.events", version: 1, scope: "session", initial: () => ({ events: {} }),
});
export interface AgentOptions {
  storePath: string;
  spec: AgentSpec;
  runtime: Runtime;
  models?: Models;
  command?: Command;
  now?: () => Date;
  recoverEveryMs?: number;
  log?: (line: string) => void;
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
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}
// The user's controls, committed to the store before they take effect.
export interface OperatorControls {
  state(): Promise<OperatorState>;
  setFrozen(frozen: boolean): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  // Queues the user's words as the next input; the same requestId is delivered once.
  message(message: { requestId: string; text: string }): Promise<void>;
  addOrder(order: string): Promise<void>;
  removeOrder(index: number): Promise<void>;
  markChecked(id: string): Promise<void>;
  // Admitted marketplace events by `event:<event_id>`, with their run state.
  events(): Promise<Record<string, EventWork>>;
  // One fresh run for an abandoned event; a failure abandons it again.
  retryEvent(eventId: string): Promise<void>;
}

function parameters(schema: typeof TOOLS[string]["schema"]): TSchema {
  const fields: Record<string, TSchema> = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    const value = property.enum ? StringEnum(property.enum) : property.type === "number" ? Type.Number() : Type.String();
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
  const spec = parseAgentSpec(o.spec);
  const runtime = parseRuntime(o.runtime);
  const agentDir = agentDirectory(runtime);
  const models = o.models ?? await createAgentModels(spec.model, { agentDir, settings: providerSettings(agentDir) });
  const log = (line: string) => { try { o.log?.(line); } catch {} };
  const now = () => (o.now?.() ?? new Date()).getTime();
  const storage = await openAgentStorage(o.storePath);
  let pi: PiEngine | undefined;
  try {
    const registry = createRegistry();
    let policy: MarketplacePolicy | undefined;
    const tools: ToolRegistration[] = Object.entries(TOOLS).map(([name, tool]) => defineTool({
      name, description: tool.description, parameters: parameters(tool.schema),
      replay: tool.kind === "read" ? "safe" : "unsafe", executionMode: "sequential",
      execute: async (args, api, ctx) => {
        if (!policy || api.conversationId !== ROOT_CONVERSATION_ID) throw new Error("marketplace policy is unavailable");
        const result = await policy.execute({ tool: name, input: args, commit: (change) => api.commit(change, ctx), signal: ctx.abortSignal });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    }));
    registry.install(defineExtension({
      name: "taskfast", tools,
      sections: [section("marketplace", async (input, ctx) => {
        const notes = (await input.read.snapshot(Policy, ctx))?.memory ?? [];
        return marketplacePrompt(spec, notes, (await input.read.snapshot(Operator, ctx))?.orders ?? []);
      }, { tag: false })],
    }));
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
    await conversation.commit(async (tx) => { await tx.doc(Events); }, context);
    let closed = false;
    let recovering: Promise<void> | undefined;
    async function recover(): Promise<void> {
      if (closed) return;
      if (recovering) return recovering;
      recovering = (async () => {
        const pending = await owner.snapshot(Events, context);
        for (const [id, work] of Object.entries(pending?.events ?? {})) {
          if (work.kind === "done" || work.kind === "abandoned") continue;
          // Only recovery changes a stored event, so `work` is current unless this pass moves it.
          let current: EventWork = work;
          if (work.kind === "submitted") {
            const submission = await owner.submission(work.submission, context);
            if (!submission) throw new Error("event submission is missing from storage");
            const result = await submission.status(context);
            if (result.status === "queued" || result.status === "placed") continue;
            current = await conversation.commit(async (tx): Promise<EventWork> => {
              const state = await tx.doc(Events);
              const event = state.events[id];
              if (result.status === "done") return state.events[id] = { ...event, kind: "done", submission: work.submission };
              if (event.attempt >= EVENT_RETRY.retries) return state.events[id] = { ...event, kind: "abandoned", submission: work.submission };
              return state.events[id] = { kind: "admitted", event: event.event, attempt: event.attempt + 1, notBefore: now() + createTimeout(event.attempt, EVENT_RETRY) };
            }, context);
            if (current.kind === "abandoned") log(`${id} abandoned after ${current.attempt + 1} failed model runs`);
          }
          if (current.kind !== "admitted" || (current.notBefore ?? 0) > now()) continue;
          // Re-read the pause state per event: a pause committed while this pass was
          // working on earlier events still stops the submissions that follow it.
          if ((await owner.snapshot(Operator, context))?.paused) continue;
          // Request dedupe covers death between submit() and saving its ID here.
          const submission = await conversation.submit({ type: "input", requestId: `event:${id}:${current.attempt}`, content: `Marketplace event:\n${JSON.stringify(current.event)}` }, context);
          await conversation.commit(async (tx) => { (await tx.doc(Events)).events[id] = { kind: "submitted", event: current.event, attempt: current.attempt, submission: submission.id }; }, context);
        }
        // Paused: settle finished runs, but submit nothing and start no work. Read it
        // again after the loop so a pause committed mid-pass also stops the drain.
        if ((await owner.snapshot(Operator, context))?.paused) return;
        // The request ID makes a resend, or a crash before the removal commits, one input.
        for (const { requestId, text } of (await owner.snapshot(Operator, context))?.messages ?? []) {
          await conversation.submit({ type: "input", requestId: `operator:${requestId}`, content: MESSAGE_PREFIX + text }, context);
          await conversation.commit(async (tx) => {
            const state = await tx.doc(Operator);
            state.messages = state.messages.filter((item) => item.requestId !== requestId);
          }, context);
        }
        owner.resume();
        const stalled = await owner.inspect(context);
        const queued = stalled.submissions.find((item) => item.status === "queued");
        // One resume input per stall: none while an earlier one is still queued or placed.
        if (!stalled.tasks.length && queued && !stalled.submissions.some((item) => item.requestId?.startsWith("resume:"))) {
          await conversation.submit({ type: "input", requestId: `resume:${queued.id}`, content: "Resume your queued marketplace work after the failed run. Read current state before any write." }, context);
        }
      })().finally(() => { recovering = undefined; });
      return recovering;
    }
    async function deliver(event: MarketEvent): Promise<void> {
      const problem = eventProblem(event);
      if (problem) throw new Error(`event refused: ${problem}`);
      // Commit durable admission only. The event pump can ACK immediately; a slow
      // model never holds its socket delivery hostage.
      await conversation.commit(async (tx) => {
        const state = await tx.doc(Events);
        const key = `event:${event.event_id}`;
        if (!Object.hasOwn(state.events, key)) {
          const json: Json = JSON.parse(JSON.stringify(event));
          state.events[key] = { kind: "admitted", event: json, attempt: 0 };
        }
      }, context);
      void recover().catch((error: unknown) => log(`event recovery: ${String(error)}`));
    }
    async function ping(): Promise<void> {
      await recover();
      if ((await owner.snapshot(Operator, context))?.paused) return;
      const work = await owner.inspect(context);
      if (work.tasks.length || work.submissions.length) return;
      await conversation.submit({ type: "input", content: `Check your marketplace work in your ${spec.role} role and pursue your current goals: ${spec.character.goals}. Read current state before acting; do not repeat uncertain writes.` }, context);
    }
    // Restore admitted events even if the process died before submitting to Pi;
    // retry failed model runs and keep queued inputs progressing without repair.
    await recover();
    const timer = setInterval(() => { void recover().catch((error: unknown) => log(`recovery: ${String(error)}`)); }, o.recoverEveryMs ?? 5000);
    timer.unref();
    // An operator action's own commit is durable before recovery runs, so — as with
    // deliver() — a recovery failure is logged, never reported as the action's result.
    const recoverLogged = async (): Promise<void> => {
      try { await recover(); }
      catch (error) { log(`recovery: ${String(error)}`); }
    };
    const operator: OperatorControls = {
      state: async () => (await owner.snapshot(Operator, context)) ?? initialOperator(),
      setFrozen: async (frozen) => { await conversation.commit(async (tx) => { (await tx.doc(Operator)).frozen = frozen; }, context); },
      setPaused: async (paused) => {
        await conversation.commit(async (tx) => { (await tx.doc(Operator)).paused = paused; }, context);
        if (paused) return;
        // A pass that started while paused may still be in flight; joining it is not
        // enough. The second call guarantees one fresh pass sees the resumed state.
        await recoverLogged();
        await recoverLogged();
      },
      message: async ({ requestId, text }) => {
        await conversation.commit(async (tx) => {
          const state = await tx.doc(Operator);
          if (!state.messages.some((item) => item.requestId === requestId)) state.messages.push({ requestId, text });
        }, context);
        await recoverLogged();
      },
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
      events: async () => (await owner.snapshot(Events, context))?.events ?? {},
      retryEvent: async (eventId) => {
        await conversation.commit(async (tx) => {
          const state = await tx.doc(Events);
          const work = state.events[`event:${eventId}`];
          if (work?.kind !== "abandoned") throw new Error(`event ${eventId} is not abandoned`);
          // A new attempt number is a new request ID; reusing the last would dedupe into the failed run.
          state.events[`event:${eventId}`] = { kind: "admitted", event: work.event, attempt: work.attempt + 1 };
        }, context);
        await recoverLogged();
      },
      markChecked: async (id) => { await conversation.commit(async (tx) => { (await tx.doc(Operator)).checked[id] = new Date(now()).toISOString(); }, context); },
    };
    // Stored entries, not the model's context, so turns from before a reset still show.
    async function transcript(limit: number): Promise<Message[]> {
      const page = await conversation.entries({ order: "descending" }, limit, undefined, context);
      return [...page.items].reverse().flatMap((entry) => entry.model ?? []);
    }
    return {
      conversation, deliver, ping, recover, status: activePolicy.snapshot, operator, transcript,
      waitForIdle: () => conversation.waitForIdle(context),
      close: async () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try { await recovering; }
        finally { await owner.close(context); }
      },
    };
  } catch (error) {
    if (pi) await pi.close(context);
    else await storage.close(context);
    throw error;
  }
}
