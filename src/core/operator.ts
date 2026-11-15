import type { Context } from "@earendil-works/chord";
import { defineDoc, InboxDoc, type Conversation, type Harness, type InboxItem, type SubmissionId, type Tx } from "@earendil-works/pi-durable";

export type QueuedOperatorMessage = { requestId: string; text: string; mode: "followUp" | "steer" };
export type SteerResult = "steered" | "already_placed" | "not_found";
export type WithdrawResult = "withdrawn" | "already_placed" | "not_found";

// What the user has told the host to do with this agent. Session-scoped like Policy,
// so reset and compaction keep it; kept apart from Policy, whose version never moves.
export type OperatorState = {
  // No money tool may reserve.
  frozen: boolean;
  // Events are still admitted and acknowledged; no new model work starts.
  paused: boolean;
  // Messages not yet handed to the conversation, oldest first.
  messages: { requestId: string; text: string; mode?: "followUp" | "steer" }[];
  // Additive v1 fields: older documents can omit them. Intents precede Pi abort.
  pendingSteers?: Record<string, { submission: SubmissionId; text: string }>;
  // Original admission order survives replacement with a new Pi submission ID.
  queuedOrder?: string[];
  // Permanent, never-pruned tombstones: retrying a withdrawn send cannot re-admit it.
  withdrawn?: Record<string, true>;
  // Standing orders, read into every system prompt. Only the user changes them.
  orders: string[];
  // Alerts the user has looked into, by action key or event id, with when. Never
  // changes the ledger: an uncertain action stays uncertain.
  checked: Record<string, string>;
};
export const initialOperator = (): OperatorState => ({ frozen: false, paused: false, messages: [], orders: [], checked: {} });
// How the conversation tells the user's words from the host's own inputs.
export const MESSAGE_PREFIX = "Message from your operator:\n";
export const Operator = defineDoc<OperatorState>({
  kind: "taskfast.operator", version: 1, scope: "session", initial: initialOperator,
});
export const FROZEN = "spending is frozen by your operator";

// Re-aborting returns `settled`. Only this persisted, unplaced abort plus a durable
// steer intent grants permission to admit the replacement after a restart.
export const unplacedAbort = (record: { status: string; reason?: string; entry?: unknown }): boolean =>
  record.status === "unanswered" && record.reason === "aborted" && record.entry === undefined;

// The user's words in a Pi inbox item; undefined for host inputs and entry writes.
function operatorInput(item: InboxItem): Omit<QueuedOperatorMessage, "requestId"> | undefined {
  if (item.mode === "write" || typeof item.content !== "string" || !item.content.startsWith(MESSAGE_PREFIX)) return undefined;
  return { text: item.content.slice(MESSAGE_PREFIX.length), mode: item.mode };
}

// What the queue machine needs from its host: the conversation it submits to and
// commits through, the committed-read handle for documents and submissions, and the
// host's answer to "may new submissions start?" while paused or held.
export interface OperatorQueueHost {
  conversation: Pick<Conversation, "id" | "commit" | "submit">;
  read: Pick<Harness, "snapshot" | "inspect" | "submission">;
  context: Context;
  // False while the owner's pause or a host scheduling hold stops new submissions;
  // buffered work and promotion replacements wait for true.
  maySchedule(): Promise<boolean>;
  // Recovery failures after durable admission are logged, never reported as the action's result.
  log(line: string): void;
}

// The operator message state machine: serialized admission, request-ID dedupe, the
// merged queue view, promotion intents, withdrawal tombstones, pending-steer recovery
// and the drain. The host keeps pause/resume orchestration, event recovery, holds.
export interface OperatorQueue {
  // Resolves when every line change queued so far has settled; quiesce and close wait here.
  idle(): Promise<void>;
  // The merged queue: Pi inbox placements, buffered messages and pending steer
  // intents, oldest first by admission order.
  read(): Promise<QueuedOperatorMessage[]>;
  // Finish every pending promotion intent, on the line, before any other submission.
  recoverSteers(): Promise<void>;
  // Submit buffered messages, steers first; stops before the first one whose
  // scheduling check fails. Prunes queue order entries left without a submission.
  drain(): Promise<void>;
  // Admit the words once per request ID: a tombstone or an earlier submission for the
  // same request ID wins, then a buffered entry with that ID.
  admit(message: { requestId: string; text: string; steer?: true }): Promise<void>;
  // Promote an unplaced message to a steer: an in-place buffer edit when still
  // buffered, otherwise a durable intent committed before the original is aborted.
  promote(requestId: string): Promise<SteerResult>;
  // Withdraw before placement, in one transaction with its permanent tombstone.
  withdraw(requestId: string): Promise<WithdrawResult>;
}
export function openOperatorQueue(host: OperatorQueueHost): OperatorQueue {
  const { conversation, read, context } = host;
  // Serializes operator admission, promotion, withdrawal and drains, not model/tool work.
  let tail: Promise<void> = Promise.resolve();
  const onLine = <T,>(change: () => Promise<T>): Promise<T> => {
    const next = tail.then(change);
    tail = next.then(() => {}, () => {});
    return next;
  };
  const mergeQueue = async (tx: Tx, requests: ReadonlyMap<SubmissionId, string>): Promise<QueuedOperatorMessage[]> => {
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
  };
  const readQueue = async (): Promise<QueuedOperatorMessage[]> => {
    const records = (await read.inspect(context)).submissions;
    const requests = new Map(records.flatMap((record): [SubmissionId, string][] => record.requestId === undefined ? [] : [[record.id, record.requestId]]));
    return conversation.commit((tx) => mergeQueue(tx, requests), context);
  };
  // Complete one promotion intent: abort the queued original, resubmit it as a steer
  // when scheduling allows, and clear the intent in the same durability as the answer.
  const finishSteer = async (requestId: string): Promise<SteerResult> => {
    const pending = (await read.snapshot(Operator, context))?.pendingSteers;
    const intent = pending && Object.hasOwn(pending, requestId) ? pending[requestId] : undefined;
    if (!intent) return "steered";
    const original = await read.submission(intent.submission, context);
    if (!original) throw new Error("operator steer submission is missing from storage");
    let record = await original.status(context);
    if (record.type !== "input" || record.conversationId !== conversation.id || record.requestId !== `operator:${requestId}`) throw new Error("operator steer submission identity changed");
    if (record.status === "queued") {
      await original.abort(context);
      record = await original.status(context);
    }
    const aborted = unplacedAbort(record);
    if (aborted) {
      if (!(await host.maySchedule())) return "steered";
      await conversation.submit({ type: "input", requestId: `operator-steer:${requestId}`, content: MESSAGE_PREFIX + intent.text, whenBusy: "steer" }, context);
    }
    await conversation.commit(async (tx) => { delete (await tx.doc(Operator)).pendingSteers?.[requestId]; }, context);
    return aborted ? "steered" : "already_placed";
  };
  const finishPendingSteers = async (): Promise<void> => {
    for (const requestId of Object.keys((await read.snapshot(Operator, context))?.pendingSteers ?? {})) await finishSteer(requestId);
  };
  return {
    idle: () => tail,
    read: readQueue,
    recoverSteers: () => onLine(finishPendingSteers),
    drain: () => onLine(async () => {
      await finishPendingSteers();
      const messages = (await read.snapshot(Operator, context))?.messages ?? [];
      // The first idle submission starts a run, so Pi cannot reorder this buffer.
      messages.sort((a, b) => Number(b.mode === "steer") - Number(a.mode === "steer"));
      for (const { requestId, text, mode } of messages) {
        if (!(await host.maySchedule())) return;
        await conversation.submit({ type: "input", requestId: `operator:${requestId}`, content: MESSAGE_PREFIX + text, whenBusy: mode ?? "followUp" }, context);
        await conversation.commit(async (tx) => {
          const state = await tx.doc(Operator);
          state.messages = state.messages.filter((item) => item.requestId !== requestId);
        }, context);
      }
      const placed = new Set((await readQueue()).map((message) => message.requestId));
      await conversation.commit(async (tx) => {
        const state = await tx.doc(Operator);
        if (state.queuedOrder) state.queuedOrder = state.queuedOrder.filter((id) => placed.has(id));
      }, context);
    }),
    admit: ({ requestId, text, steer }) => onLine(() => conversation.commit(async (tx) => {
      const state = await tx.doc(Operator);
      if (state.withdrawn && Object.hasOwn(state.withdrawn, requestId)) return;
      if (await tx.submissionByRequest(conversation.id, `operator:${requestId}`)) return;
      if (await tx.submissionByRequest(conversation.id, `operator-steer:${requestId}`)) return;
      if (!state.messages.some((item) => item.requestId === requestId)) {
        state.messages.push({ requestId, text, mode: steer ? "steer" : "followUp" });
        state.queuedOrder = [...(state.queuedOrder ?? []), requestId];
      }
    }, context)),
    promote: (requestId) => onLine(async (): Promise<SteerResult> => {
      // Capture legacy inbox order before withdrawal replaces its oldest ID.
      const order = (await readQueue()).map((message) => message.requestId);
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
      catch (error) { host.log(`operator steer recovery: ${String(error)}`); return "steered"; }
    }),
    withdraw: (requestId) => onLine(() => conversation.commit(async (tx): Promise<WithdrawResult> => {
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
  };
}
