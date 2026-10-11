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

// In-character only. Reads the character, the role and the temperament's manner
// phrase; the numeric dials are never interpolated.
export function buildSystemPrompt({ role, character: c, dials }: AgentSpec): string {
  return [
    `You are ${c.name}, who runs ${c.businessName}. ${c.businessDescription}`,
    `What you want right now: ${c.goals}.`,
    ...(role !== "worker" && c.budgetUsd !== undefined ? [`You have about $${c.budgetUsd} to spend on a single job.`] : []),
    `You are ${MANNER[dials.temperament]}.`,
    `${MARKET[role]}, writing the way you normally would.`,
  ].join("\n");
}
