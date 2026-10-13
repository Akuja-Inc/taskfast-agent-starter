import type { Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { MESSAGE_PREFIX } from "./operator.js";
import { UUID } from "./tools.js";

// What the console shows: each input the agent received, then its replies.
export type TurnKind = "poll" | "event" | "operator" | "resume" | "other";
export interface Turn { kind: TurnKind; at: number; text: string; event?: unknown; replies: Reply[] }
export interface Reply { text: string; calls: Call[]; tasks: TaskRef[] }
export type Outcome = "ok" | "failed" | "uncertain" | "pending";
export interface Call { id: string; name: string; arguments: unknown; outcome: Outcome; result?: string; error?: string }
export interface TaskRef { id: string; via: string }

const EVENT_PREFIX = "Marketplace event:\n";
const text = (content: UserMessage["content"] | ToolResultMessage["content"]) =>
  typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
function parse(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;

function classify(content: string): Pick<Turn, "kind" | "text" | "event"> {
  if (content.startsWith(EVENT_PREFIX)) return { kind: "event", text: content.slice(EVENT_PREFIX.length), event: parse(content.slice(EVENT_PREFIX.length)) };
  if (content.startsWith(MESSAGE_PREFIX)) return { kind: "operator", text: content.slice(MESSAGE_PREFIX.length) };
  if (content.startsWith("Check your marketplace work")) return { kind: "poll", text: content };
  if (content.startsWith("Resume your queued marketplace work")) return { kind: "resume", text: content };
  return { kind: "other", text: content };
}
// Policy answers a write with { uncertain } or { failed | refused | error }; a read's error is { error }.
function settle(call: Call, message: ToolResultMessage): void {
  const body = text(message.content);
  const value = parse(body);
  const problem = field(value, "uncertain") ?? field(value, "failed") ?? field(value, "refused") ?? field(value, "error");
  call.outcome = field(value, "uncertain") !== undefined ? "uncertain" : message.isError || problem !== undefined ? "failed" : "ok";
  if (call.outcome === "ok") call.result = body;
  else call.error = typeof problem === "string" ? problem : body;
}
function taskIds(call: Call): string[] {
  const ids = [field(call.arguments, "task_id")];
  if (call.name === "post_task" && call.result) {
    const posted = parse(call.result);
    ids.push(field(field(posted, "task"), "id"), field(posted, "task_id"), field(posted, "id"));
  }
  return ids.filter((id): id is string => typeof id === "string" && UUID.test(id));
}

export function buildTimeline(messages: readonly Message[]): Turn[] {
  const turns: Turn[] = [];
  const calls = new Map<string, { call: Call; reply: Reply }>();
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ ...classify(text(message.content)), at: message.timestamp, replies: [] });
      continue;
    }
    const turn = turns.at(-1);
    if (!turn) continue;
    if (message.role === "assistant") {
      const reply: Reply = { text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""), calls: [], tasks: [] };
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        const call: Call = { id: part.id, name: part.name, arguments: part.arguments, outcome: "pending" };
        reply.calls.push(call);
        calls.set(part.id, { call, reply });
      }
      turn.replies.push(reply);
      continue;
    }
    if (message.role !== "toolResult") continue;
    const match = calls.get(message.toolCallId);
    if (!match) continue;
    settle(match.call, message);
    for (const id of taskIds(match.call)) {
      if (!match.reply.tasks.some((task) => task.id === id)) match.reply.tasks.push({ id, via: match.call.name });
    }
  }
  return turns;
}
