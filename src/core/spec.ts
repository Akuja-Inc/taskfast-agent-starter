import { MANNER, MARKET } from "./prompt.js";
import type { AgentFile, AgentSpec, Limits } from "./types.js";

// The agent folder file holding the agent's instructions, and the most it may hold.
export const INSTRUCTIONS_PATH = "INSTRUCTIONS.md";
export const MAX_INSTRUCTIONS = 20_000;
const FILE_KEYS = ["role", "model", "dials", "limits"] as const;

const fail = (why: string): never => {
  throw new Error(`invalid agent file: ${why}`);
};

// Unknown keys are refused, so a typo ("temprament") fails loudly instead of
// silently falling back.
function record(v: unknown, at: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return fail(`${at} must be an object`);
  for (const k of Object.keys(v)) if (!keys.includes(k)) fail(`${at}.${k} is not a known field`);
  return v as Record<string, unknown>;
}

// The allowed values are the keys of a Record over the union type, so the compiler
// keeps this list and the type in step.
function oneOf<K extends string>(v: unknown, at: string, allowed: Record<K, unknown>): K {
  if (typeof v !== "string" || !Object.hasOwn(allowed, v)) return fail(`${at} must be one of ${Object.keys(allowed).join(", ")}`);
  return v as K;
}

function text(v: unknown, at: string): string {
  if (typeof v !== "string" || !v.trim()) return fail(`${at} must be a non-empty string`);
  return v;
}

function positive(v: unknown, at: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return fail(`${at} must be a positive number`);
  return v;
}

function unit(v: unknown, at: string): number {
  if (typeof v !== "number" || !(v >= 0 && v <= 1)) return fail(`${at} must be a number from 0 to 1`);
  return v;
}

function parseLimits(v: unknown): Limits {
  const l = record(v, "limits", ["perJobUsd", "dailyUsd"]);
  const out: Limits = {};
  if (l.perJobUsd !== undefined) out.perJobUsd = positive(l.perJobUsd, "limits.perJobUsd");
  if (l.dailyUsd !== undefined) out.dailyUsd = positive(l.dailyUsd, "limits.dailyUsd");
  return out;
}

// The model id grammar, "provider:model": a provider name in [a-z0-9-] (an
// @ai-sdk/<provider> package, see model.ts), then the provider's own model id.
export function splitModel(id: unknown): { provider: string; modelId: string } {
  const model = text(id, "model");
  if (!/^[a-z0-9-]+:\S+$/.test(model)) fail(`model must be "provider:model", got ${JSON.stringify(model)}`);
  const at = model.indexOf(":");
  return { provider: model.slice(0, at), modelId: model.slice(at + 1) };
}

// agent.json's character from before INSTRUCTIONS.md: ignored, and the host warns about it.
export const hasStaleCharacter = (raw: unknown): boolean => typeof raw === "object" && raw !== null && "character" in raw;
export const STALE_CHARACTER = `agent.json still has character, which is ignored now; write the agent's name, business, goals and budget in ${INSTRUCTIONS_PATH} in your own words, then remove character`;

// Validates agent.json (parsed JSON) and returns a copy holding only known fields.
export function parseAgentFile(raw: unknown): AgentFile {
  const o = record(raw, "agent", [...FILE_KEYS, "character"]);
  const role = oneOf(o.role, "role", MARKET);
  const model = o.model as string;
  splitModel(model);

  const d = record(o.dials, "dials", ["competence", "diligence", "priceSensitivity", "temperament"]);
  const limits = o.limits === undefined ? undefined : parseLimits(o.limits);
  return {
    ...(limits ? { limits } : {}),
    role,
    model,
    dials: {
      competence: unit(d.competence, "dials.competence"),
      diligence: unit(d.diligence, "dials.diligence"),
      priceSensitivity: unit(d.priceSensitivity, "dials.priceSensitivity"),
      temperament: oneOf(d.temperament, "dials.temperament", MANNER),
    },
  };
}

// Validates the whole agent: agent.json's fields plus the instructions text.
export function parseAgentSpec(raw: unknown): AgentSpec {
  const { instructions, ...file } = record(raw, "agent", [...FILE_KEYS, "instructions"]);
  const at = `instructions (${INSTRUCTIONS_PATH})`;
  if (text(instructions, at).length > MAX_INSTRUCTIONS) fail(`${at} must be at most ${MAX_INSTRUCTIONS} characters`);
  return { ...parseAgentFile(file), instructions: instructions as string };
}

// The agent.json part of an agent, for writing the file.
export function agentFile({ instructions: _, ...file }: AgentSpec): AgentFile {
  return file;
}
