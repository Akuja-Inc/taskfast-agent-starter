import type { MarketEvent } from "./types.js";

// How an actor calls itself. A queued self-call runs after the current call commits,
// which is what lets a turn move one committed step at a time.
export interface SelfActor {
  deliver(event: MarketEvent): Promise<void>;
  step(token: string): Promise<void>;
}

// The generated client is loaded at run time from an absolute file URL
// (PERSONA_ACTORS_CLIENT): the runtime bundles actor code into its own directory, so a
// relative path does not reach the package's generated/ folder. This is the core's
// one computed import (allowed by name in test/core-boundary.test.ts).
let loader: (id: string) => Promise<SelfActor> = async (id) => {
  const url = process.env.PERSONA_ACTORS_CLIENT;
  if (!url) throw new Error("PERSONA_ACTORS_CLIENT is not set: point it at generated/index.js as a file:// URL");
  const mod = (await import(url)) as { actors: { Persona: { get(id: string): SelfActor } } };
  return mod.actors.Persona.get(id);
};

export const selfActor = (id: string): Promise<SelfActor> => loader(id);

// For tests: replace how an actor reaches itself.
export function setSelfLoader(f: (id: string) => Promise<SelfActor>): void {
  loader = f;
}
