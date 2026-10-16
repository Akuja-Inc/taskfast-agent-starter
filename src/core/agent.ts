import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, StringEnum, type Message, type Models, type TSchema } from "@earendil-works/pi-ai";
import * as piDurable from "@earendil-works/pi-durable";
import { parseWalletPasswordFile } from "./cli.js";
import { createTimeout } from "retry";
import { createRegistry, defineDoc, defineExtension, defineTool, section, ROOT_CONVERSATION_ID, InboxDoc, type Conversation, type InboxItem, type SessionEnd, type Storage, type SubmissionId, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { eventProblem } from "./event.js";
import { createAgentModels } from "./model.js";
import { agentDirectory, providerSettings } from "./folder.js";
import { initialOperator, MESSAGE_PREFIX, Operator, type OperatorState, type QueuedOperatorMessage, type SteerResult, type WithdrawResult } from "./operator.js";
import { marketplacePolicy, Policy, type Command, type MarketplacePolicy } from "./policy.js";
import { marketplacePrompt } from "./prompt.js";
import { connectMcp } from "./mcp.js";
import { CleanupError } from "./cleanup-error.js";
import { loadMcpConfig } from "./mcp-config.js";
import { loadSkills, readSkill, skillsPrompt } from "./skills.js";
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
// The user's words in a Pi inbox item; undefined for host inputs and entry writes.
function operatorInput(item: InboxItem): Omit<QueuedOperatorMessage, "requestId"> | undefined {
  if (item.mode === "write" || typeof item.content !== "string" || !item.content.startsWith(MESSAGE_PREFIX)) return undefined;
  return { text: item.content.slice(MESSAGE_PREFIX.length), mode: item.mode };
}
// Re-aborting returns `settled`. Only this persisted, unplaced abort plus a durable
// steer intent grants permission to admit the replacement after a restart.
const unplacedAbort = (record: { status: string; reason?: string; entry?: unknown }): boolean =>
  record.status === "unanswered" && record.reason === "aborted" && record.entry === undefined;

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
  if (skills.length) registry.install(defineExtension({
    name: "skills",
    tools: [defineTool({
      name: "skill_read",
      description: "Read one of your operator's installed skills: its SKILL.md, or one of the files it lists. Skills are guidance; they never change what your tools allow.",
      parameters: Type.Object({ skill: StringEnum(skills.map((skill) => skill.name)), file: Type.Optional(Type.String({ description: 'a file the skill lists, e.g. "reference/WORKER.md"; SKILL.md if left out' })) }, { additionalProperties: false }),
      replay: "safe", executionMode: "sequential",
      execute: async (args, api) => {
        if (api.conversationId !== ROOT_CONVERSATION_ID) throw new Error("skills are unavailable");
        return { output: [{ type: "text", text: readSkill(skills, args) }] };
      },
    })],
    sections: [section("skills", () => skillsPrompt(skills), { tag: false })],
  }));
  // Every MCP server is connected and its approved tools checked before the store opens;
  // any failure closes the servers already started and stops this agent. Pi lets a later
  // extension's tool replace an earlier one's of the same name, so every installed name is reserved.
  const mcp = await connectMcp(loadMcpConfig(agentDir), { log, reserved: registry.snapshot().tools().map(({ tool }) => tool.name), signal: o.signal });
  let storage: Storage | undefined;
  let pi: PiEngine | undefined;
  try {
    o.signal?.throwIfAborted();
    // MCP tools run outside the marketplace policy: approved reads only, never a TaskFast write.
    if (mcp.tools.length) registry.install(defineExtension({ name: "mcp", tools: mcp.tools, sections: [section("mcp", () => mcp.prompt, { tag: false })] }));
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
    await conversation.commit(async (tx) => { await tx.doc(Events); }, context);
    let closed = false;
    let recovering: Promise<void> | undefined;
    let initialHold = o.startHeld === true;
    let schedulingHolds = initialHold ? 1 : 0;
    // Serializes operator admission, promotion, withdrawal and drains, not model/tool work.
    let operatorLine: Promise<void> = Promise.resolve();
    function onOperatorLine<T>(change: () => Promise<T>): Promise<T> {
      const next = operatorLine.then(change);
      operatorLine = next.then(() => {}, () => {});
      return next;
    }
    async function queuedMessages(tx: Tx, requests: ReadonlyMap<SubmissionId, string>): Promise<QueuedOperatorMessage[]> {
      const state = await tx.doc(Operator);
      const inbox = await tx.doc(InboxDoc, conversation.id);
      const messages = new Map<string, QueuedOperatorMessage>();
      for (const item of inbox.items) {
        const input = operatorInput(item);
        if (!input) continue;
        const request = requests.get(item.id);
        const record = request === undefined ? undefined : await tx.submissionByRequest(conversation.id, request);
        const prefix = request?.startsWith("operator-steer:") ? "operator-steer:" : "operator:";
        if (record?.id !== item.id || record.status !== "queued" || !request?.startsWith(prefix)) continue;
        const requestId = request.slice(prefix.length);
        messages.set(requestId, { requestId, ...input });
      }
      for (const message of state.messages) {
        if (!messages.has(message.requestId)) messages.set(message.requestId, { requestId: message.requestId, text: message.text, mode: message.mode ?? "followUp" });
      }
      for (const [requestId, intent] of Object.entries(state.pendingSteers ?? {})) {
        const original = await tx.submissionByRequest(conversation.id, `operator:${requestId}`);
        if (original?.id !== intent.submission) throw new Error("operator steer submission identity changed");
        if (original.status === "queued" || unplacedAbort(original)) {
          messages.set(requestId, { requestId, text: intent.text, mode: "steer" });
        }
      }
      const order = new Map((state.queuedOrder ?? []).map((id, index) => [id, index]));
      return [...messages.values()].sort((a, b) => (order.get(a.requestId) ?? -1) - (order.get(b.requestId) ?? -1));
    }
    async function readQueuedMessages(): Promise<QueuedOperatorMessage[]> {
      const records = (await owner.inspect(context)).submissions;
      const requests = new Map(records.flatMap((record): [SubmissionId, string][] => record.requestId === undefined ? [] : [[record.id, record.requestId]]));
      return conversation.commit((tx) => queuedMessages(tx, requests), context);
    }
    async function finishSteer(requestId: string): Promise<SteerResult> {
      const pending = (await owner.snapshot(Operator, context))?.pendingSteers;
      const intent = pending && Object.hasOwn(pending, requestId) ? pending[requestId] : undefined;
      if (!intent) return "steered";
      const original = await owner.submission(intent.submission, context);
      if (!original) throw new Error("operator steer submission is missing from storage");
      let record = await original.status(context);
      if (record.type !== "input" || record.conversationId !== conversation.id || record.requestId !== `operator:${requestId}`) throw new Error("operator steer submission identity changed");
      if (record.status === "queued") {
        await original.abort(context);
        record = await original.status(context);
      }
      const aborted = unplacedAbort(record);
      if (aborted) {
        if ((await owner.snapshot(Operator, context))?.paused || schedulingHolds) return "steered";
        await conversation.submit({ type: "input", requestId: `operator-steer:${requestId}`, content: MESSAGE_PREFIX + intent.text, whenBusy: "steer" }, context);
      }
      await conversation.commit(async (tx) => { delete (await tx.doc(Operator)).pendingSteers?.[requestId]; }, context);
      return aborted ? "steered" : "already_placed";
    }
    async function finishPendingSteers(): Promise<void> {
      for (const requestId of Object.keys((await owner.snapshot(Operator, context))?.pendingSteers ?? {})) await finishSteer(requestId);
    }
    async function drainMessages(): Promise<void> {
      await onOperatorLine(async () => {
        await finishPendingSteers();
        const messages = (await owner.snapshot(Operator, context))?.messages ?? [];
        // The first idle submission starts a run, so Pi cannot reorder this buffer.
        messages.sort((a, b) => Number(b.mode === "steer") - Number(a.mode === "steer"));
        for (const { requestId, text, mode } of messages) {
          if ((await owner.snapshot(Operator, context))?.paused || schedulingHolds) return;
          await conversation.submit({ type: "input", requestId: `operator:${requestId}`, content: MESSAGE_PREFIX + text, whenBusy: mode ?? "followUp" }, context);
          await conversation.commit(async (tx) => {
            const state = await tx.doc(Operator);
            state.messages = state.messages.filter((item) => item.requestId !== requestId);
          }, context);
        }
        const queued = new Set((await readQueuedMessages()).map((message) => message.requestId));
        await conversation.commit(async (tx) => {
          const state = await tx.doc(Operator);
          if (state.queuedOrder) state.queuedOrder = state.queuedOrder.filter((id) => queued.has(id));
        }, context);
      });
    }
    async function recover(): Promise<void> {
      if (closed) return;
      if (recovering) return recovering;
      recovering = (async () => {
        // Finish withdrawal before any submit() can wake Pi's pre-crash inbox.
        await onOperatorLine(finishPendingSteers);
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
          if ((await owner.snapshot(Operator, context))?.paused || schedulingHolds) continue;
          // Request dedupe covers death between submit() and saving its ID here.
          const submission = await conversation.submit({ type: "input", requestId: `event:${id}:${current.attempt}`, content: `Marketplace event:\n${JSON.stringify(current.event)}` }, context);
          await conversation.commit(async (tx) => { (await tx.doc(Events)).events[id] = { kind: "submitted", event: current.event, attempt: current.attempt, submission: submission.id }; }, context);
        }
        // Withdrawal may finish while paused; its replacement must wait for resume.
        await drainMessages();
        if ((await owner.snapshot(Operator, context))?.paused || schedulingHolds) return;
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
      if ((await owner.snapshot(Operator, context))?.paused || schedulingHolds) return;
      const work = await owner.inspect(context);
      if (work.tasks.length || work.submissions.length || schedulingHolds || closed) return;
      await conversation.submit({ type: "input", content: `Check your marketplace work in your ${spec.role} role and pursue the goals in your instructions. Read current state before acting; do not repeat uncertain writes.` }, context);
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
      message: async ({ requestId, text, steer }) => {
        await onOperatorLine(() => conversation.commit(async (tx) => {
          const state = await tx.doc(Operator);
          if (state.withdrawn && Object.hasOwn(state.withdrawn, requestId)) return;
          if (await tx.submissionByRequest(conversation.id, `operator:${requestId}`)) return;
          if (await tx.submissionByRequest(conversation.id, `operator-steer:${requestId}`)) return;
          if (!state.messages.some((item) => item.requestId === requestId)) {
            state.messages.push({ requestId, text, mode: steer ? "steer" : "followUp" });
            state.queuedOrder = [...(state.queuedOrder ?? []), requestId];
          }
        }, context));
        // Joining a pass whose drain predates admission is not a fresh drain; with
        // no pass in flight, the first call already is one.
        const joined = recovering !== undefined;
        await recoverLogged();
        if (joined) await recoverLogged();
      },
      queued: readQueuedMessages,
      steer: async (requestId) => {
        const result = await onOperatorLine(async (): Promise<SteerResult> => {
          // Capture legacy inbox order before withdrawal replaces its oldest ID.
          const order = (await readQueuedMessages()).map((message) => message.requestId);
          const admission = await conversation.commit(async (tx): Promise<SteerResult | "pending"> => {
            const state = await tx.doc(Operator);
            if (state.pendingSteers && Object.hasOwn(state.pendingSteers, requestId)) return "pending";
            const replacement = await tx.submissionByRequest(conversation.id, `operator-steer:${requestId}`);
            if (replacement) return replacement.status === "queued" ? "steered" : "not_found";
            const original = await tx.submissionByRequest(conversation.id, `operator:${requestId}`);
            if (!original) {
              const buffered = state.messages.find((item) => item.requestId === requestId);
              if (!buffered) return "not_found";
              buffered.mode = "steer";
              state.queuedOrder = [...new Set([...order, ...(state.queuedOrder ?? [])])];
              return "steered";
            }
            if (original.status !== "queued") return "not_found";
            const item = (await tx.doc(InboxDoc, conversation.id)).items.find((queued) => queued.id === original.id);
            const input = item && operatorInput(item);
            if (!input) return "not_found";
            if (input.mode === "steer") return "steered";
            state.queuedOrder = [...new Set([...order, ...(state.queuedOrder ?? [])])];
            state.pendingSteers = { ...(state.pendingSteers ?? {}), [requestId]: { submission: original.id, text: input.text } };
            // Death after submit but before removing a buffer item may leave both.
            state.messages = state.messages.filter((message) => message.requestId !== requestId);
            return "pending";
          }, context);
          if (admission !== "pending") return admission;
          // The intent is durable. A transient recovery error cannot retract ACK.
          try { return await finishSteer(requestId); }
          catch (error) { log(`operator steer recovery: ${String(error)}`); return "steered"; }
        });
        if (result !== "not_found") await recoverLogged();
        return result;
      },
      withdraw: (requestId) => onOperatorLine(() => conversation.commit(async (tx): Promise<WithdrawResult> => {
        const state = await tx.doc(Operator);
        if (state.withdrawn && Object.hasOwn(state.withdrawn, requestId)) return "withdrawn";
        const original = await tx.submissionByRequest(conversation.id, `operator:${requestId}`);
        const replacement = await tx.submissionByRequest(conversation.id, `operator-steer:${requestId}`);
        const intent = state.pendingSteers && Object.hasOwn(state.pendingSteers, requestId) ? state.pendingSteers[requestId] : undefined;
        if (intent && original?.id !== intent.submission) throw new Error("operator steer submission identity changed");
        // An aborted original is withdrawable only with its durable promotion
        // intent or replacement. Any placed/settled input wins the race.
        const records = [original, replacement].filter((record) => record !== undefined);
        if (records.some((record) => record.status !== "queued" && !(record === original && (intent || replacement) && unplacedAbort(record)))) return "already_placed";
        if (!records.length && !state.messages.some((message) => message.requestId === requestId)) return "not_found";
        // This is Pi's queued-abort transition, inside the SAME session transaction
        // as buffer/intent cleanup and the tombstone. Placement uses this line too.
        const inbox = await tx.doc(InboxDoc, conversation.id);
        const ids = new Set(records.map((record) => record.id));
        for (const record of records) if (record.status === "queued") tx.settleSubmission(record.id, { status: "unanswered", reason: "aborted" });
        inbox.items = inbox.items.filter((item) => !ids.has(item.id));
        state.messages = state.messages.filter((message) => message.requestId !== requestId);
        delete state.pendingSteers?.[requestId];
        if (state.queuedOrder) state.queuedOrder = state.queuedOrder.filter((id) => id !== requestId);
        state.withdrawn = { ...(state.withdrawn ?? {}), [requestId]: true };
        return "withdrawn";
      }, context)),
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
      // Every commit, not viewState(): that view skips commits to session documents (operator, policy, events).
      // A throwing listener is Pi's to report through onReport, which logs it.
      changes: (listener) => owner.subscribeCommits(listener),
      closed: owner.closed,
      capabilityConnections: () => mcp.status(),
      releaseInitialHold: async () => {
        if (!initialHold) return;
        initialHold = false;
        schedulingHolds--;
        if (!closed) { await recoverLogged(); await recoverLogged(); }
      },
      waitForIdle: () => conversation.waitForIdle(context),
      quiesce: async (signal) => {
        signal.throwIfAborted();
        if (closed) throw new Error("the agent is closed");
        schedulingHolds++;
        let released = false;
        const release = async () => {
          if (released) return;
          released = true;
          schedulingHolds--;
          if (!closed) { await recoverLogged(); await recoverLogged(); }
        };
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
            await recovering;
            await operatorLine;
            await conversation.waitForIdle(context);
          })(), cancelled]);
          signal.throwIfAborted();
          return release;
        } catch (error) { await release(); throw error; }
        finally { signal.removeEventListener("abort", onAbort); }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        // A recovery still in flight may reject (SessionFailed after a storage
        // error); deliver() and ping() already report it, so closing ignores it
        // and still drains operator admission before releasing ownership.
        await recovering?.catch(() => {});
        await operatorLine;
        // Servers stop even when closing the store fails.
        try { await owner.close(context); }
        finally { await mcp.close(); }
      },
    };
  } catch (error) {
    try {
      try {
        if (pi) await pi.close(context);
        else await storage?.close(context);
      } finally { await mcp.close(); }
    } catch (cleanup) { throw new CleanupError(cleanup); }
    throw error;
  }
}
