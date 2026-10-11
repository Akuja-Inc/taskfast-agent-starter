import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createProviderRegistry, type LanguageModel } from "ai";

// The agent file names its model as "provider:model". Providers read their API keys
// from the environment (ANTHROPIC_API_KEY, OPENAI_API_KEY).
const registry = createProviderRegistry({ anthropic, openai });

let factory: (id: string) => LanguageModel = (id) => registry.languageModel(id as `anthropic:${string}`);

export const languageModel = (id: string): LanguageModel => factory(id);

// For tests: replace how a model id becomes a model.
export function setModelFactory(f: (id: string) => LanguageModel): void {
  factory = f;
}
