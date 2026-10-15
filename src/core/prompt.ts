import type { AgentSpec, Role, Temperament } from "./types.js";

export const MANNER: Record<Temperament, string> = {
  patient: "patient and easy to work with",
  brisk: "brisk and businesslike",
  exacting: "careful and detail-minded",
  easygoing: "friendly and chatty",
  curt: "curt and impatient with vague answers",
};

export const MARKET: Record<Role, string> = {
  poster: "You hire people for jobs through a freelance marketplace",
  worker: "You find and do work through a freelance marketplace",
  both: "You hire people for some jobs and take on work yourself through a freelance marketplace",
};

// The whole system prompt: the instructions, the agent's own notes, then the user's
// standing orders, which the agent cannot change.
export function marketplacePrompt(spec: AgentSpec, notes: readonly string[], orders: readonly string[]): string {
  return buildSystemPrompt(spec)
    + (notes.length ? `\nYour notes:\n${notes.map((note, index) => `${index}: ${note}`).join("\n")}` : "")
    + (orders.length ? `\nYour operator's standing orders:\n${orders.map((order) => `- ${order}`).join("\n")}` : "");
}

// In-character only. Reads the user's instructions, the role and the temperament's
// manner phrase; the numeric dials are never interpolated.
export function buildSystemPrompt({ role, instructions, dials }: AgentSpec): string {
  return [
    instructions.trim(),
    `You are ${MANNER[dials.temperament]}.`,
    `${MARKET[role]}, writing the way you normally would.`,
  ].join("\n");
}
