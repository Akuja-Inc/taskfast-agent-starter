import { generateText, jsonSchema, tool, type LanguageModel } from "ai";
import { buildSystemPrompt } from "./prompt.js";
import { TOOLS } from "./tools.js";
import type { AgentSpec, Json, MarketEvent, TurnEntry } from "./types.js";

// One value shown to the model or kept in a turn, capped in size: a large listing would
// otherwise be re-sent on every later step and could overflow the model's context.
// This caps one value, not the turn.
const CLIP = 8_000;
export function clip(v: Json): Json {
  const s = JSON.stringify(v);
  return s.length <= CLIP ? v : { truncated: `${s.length - CLIP} more characters`, head: s.slice(0, CLIP) };
}

export type Decision = { type: "call"; tool: string; input: Json } | { type: "end"; note: string };

const GUIDE = [
  "You act on your own. Each time you are woken, look at what is new, decide what to do, and do it with your tools, one at a time.",
  "When you have nothing more to do for now, answer in plain words without calling a tool.",
  "If a tool result says the outcome is unknown, check the current state with a read tool before trying again.",
].join("\n");

// The tools offered to the model, with no execute: the model only proposes a call,
// and the actor runs it in a separate committed step.
const offered = Object.fromEntries(Object.entries(TOOLS).map(([name, t]) => [name, tool({ description: t.description, inputSchema: jsonSchema(t.schema as Parameters<typeof jsonSchema>[0]) })]));

// One model call: the next tool call, or the end of the turn. Throws on a model
// error, so the caller's actor call rolls back and nothing is committed.
export async function decideNext(model: LanguageModel, o: { spec: AgentSpec; memory: string[]; events: MarketEvent[]; transcript: TurnEntry[] }): Promise<Decision> {
  const context = [
    o.memory.length ? `Your notes:\n${o.memory.map((n, i) => `${i}. ${n}`).join("\n")}` : "You have no notes yet.",
    o.events.length ? `What happened since you last looked:\n${JSON.stringify(o.events.map((e) => clip(e as unknown as Json)))}` : "Nothing new has happened; this is a routine check.",
    o.transcript.length ? `What you have done so far this time:\n${JSON.stringify(o.transcript)}` : "",
  ].filter(Boolean).join("\n\n");
  const r = await generateText({ model, system: `${buildSystemPrompt(o.spec)}\n\n${GUIDE}`, prompt: context, tools: offered, toolChoice: "auto" });
  const call = r.toolCalls[0];
  if (call) return { type: "call", tool: call.toolName, input: (call.input ?? {}) as Json };
  return { type: "end", note: r.text.trim() };
}
