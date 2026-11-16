import type { Context } from "@earendil-works/chord";
import { defineDoc, type Conversation, type Harness, type SubmissionId } from "@earendil-works/pi-durable";
import { createTimeout } from "retry";
import { eventProblem } from "./event.js";
import type { Json, MarketEvent } from "./types.js";

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

export interface EventWorkHost {
  conversation: Pick<Conversation, "commit" | "submit">;
  read: Pick<Harness, "snapshot" | "submission">;
  context: Context;
  now(): number;
  log(line: string): void;
  maySchedule(): Promise<boolean>;
}

// Admission is durable before ACK. The host serializes advance passes through
// its scheduling gate; admission and owner retry commit independently of a pass.
export async function openEventWork(host: EventWorkHost) {
  const { conversation, read, context, now, log } = host;
  await conversation.commit(async (tx) => { await tx.doc(Events); }, context);
  return {
    admit: async (event: MarketEvent): Promise<void> => {
      const problem = eventProblem(event);
      if (problem) throw new Error(`event refused: ${problem}`);
      await conversation.commit(async (tx) => {
        const state = await tx.doc(Events);
        const key = `event:${event.event_id}`;
        if (!Object.hasOwn(state.events, key)) {
          const json: Json = JSON.parse(JSON.stringify(event));
          state.events[key] = { kind: "admitted", event: json, attempt: 0 };
        }
      }, context);
    },
    advance: async (): Promise<void> => {
      const pending = await read.snapshot(Events, context);
      for (const [id, work] of Object.entries(pending?.events ?? {})) {
        if (work.kind === "done" || work.kind === "abandoned") continue;
        // Only this pass changes active work; retry changes abandoned records only.
        let current: EventWork = work;
        if (work.kind === "submitted") {
          const submission = await read.submission(work.submission, context);
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
        if (!(await host.maySchedule())) continue;
        // Request dedupe covers death between submit() and saving its ID here.
        const submission = await conversation.submit({ type: "input", requestId: `event:${id}:${current.attempt}`, content: `Marketplace event:\n${JSON.stringify(current.event)}` }, context);
        await conversation.commit(async (tx) => { (await tx.doc(Events)).events[id] = { kind: "submitted", event: current.event, attempt: current.attempt, submission: submission.id }; }, context);
      }
    },
    retry: async (eventId: string): Promise<void> => {
      await conversation.commit(async (tx) => {
        const state = await tx.doc(Events);
        const work = state.events[`event:${eventId}`];
        if (work?.kind !== "abandoned") throw new Error(`event ${eventId} is not abandoned`);
        // A new attempt number is a new request ID, not the failed run's dedupe key.
        state.events[`event:${eventId}`] = { kind: "admitted", event: work.event, attempt: work.attempt + 1 };
      }, context);
    },
    read: async (): Promise<Record<string, EventWork>> => (await read.snapshot(Events, context))?.events ?? {},
  };
}
