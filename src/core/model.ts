import { createModels, createProvider, type Models, type Provider } from "@earendil-works/pi-ai/models";
import type { Api, Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PROVIDERS, type ProviderSource } from "./providers.js";
import { splitModel } from "./spec.js";

// Explicit allow-list. A provider ID is never a package name or an import path.
export function providerSource(id: string): ProviderSource {
  const source = Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : undefined;
  if (!source) throw new Error(`unsupported model provider "${id}"; see docs/providers.md and providers.json`);
  return source;
}

// Custom endpoints/deployments have no reliable catalog metadata. Do not borrow
// reasoning, vision, prices or compatibility claims from an unrelated model.
function customModel({ id, provider, api, baseUrl }: { id: string; provider: string; api: Api; baseUrl: string }): Model<Api> {
  return {
    id, name: id, provider, api, baseUrl, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768, maxTokens: 4096,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false, maxTokensField: "max_tokens" },
  };
}

function ollamaProvider(modelId: string): Provider {
  const baseUrl = "http://127.0.0.1:11434/v1";
  return createProvider({
    id: "ollama", name: "Ollama", baseUrl,
    models: [customModel({ id: modelId, provider: "ollama", api: "openai-completions", baseUrl })],
    auth: {
      apiKey: {
        name: "Ollama (optional proxy key)",
        resolve: async ({ ctx, credential, signal }) => {
          signal.throwIfAborted();
          const apiKey = credential?.key || await ctx.env("OLLAMA_API_KEY") || "ollama";
          const url = credential?.env?.OLLAMA_BASE_URL ?? await ctx.env("OLLAMA_BASE_URL") ?? baseUrl;
          signal.throwIfAborted();
          return { auth: { apiKey, baseUrl: url }, source: "Ollama endpoint" };
        },
      },
    },
    api: openAICompletionsApi(),
  });
}

/** A private collection with only this agent's requested provider registered.
 * No model/auth requests or package installation occur during construction.
 * Native chat metadata comes from the pinned catalog; unknown IDs are refused
 * except pulled Ollama models and Azure deployment names.
 */
export async function createAgentModels(id: string): Promise<Models> {
  const { provider: name, modelId } = splitModel(id);
  const source = providerSource(name);
  const native = source.create ? await source.create() : ollamaProvider(modelId);
  let deployment: Model<Api> | undefined;
  if (!native.getModels().some((model) => model.id === modelId)) {
    const template = name === "azure" ? native.getModels().find((model) => model.api === "azure-openai-responses") : undefined;
    if (!template) throw new Error(`unsupported model "${id}" in the pinned chat catalog; see providers.json`);
    deployment = customModel({ id: modelId, provider: native.id, api: template.api, baseUrl: template.baseUrl });
  }
  const chatModels = () => {
    const current = native.getModels();
    return (deployment ? [...current, deployment] : current).map((model) => ({ ...model, provider: name }));
  }
  // Preserve setup aliases in lookup and model IDs while dispatching with the
  // native identity, which provider-specific protocol behavior can depend on.
  const provider: Provider = {
    ...native,
    id: name,
    getModels: chatModels,
    getAllModels: chatModels,
    stream: (model, context, options) => native.stream({ ...model, provider: native.id }, context, options),
    streamSimple: (model, context, options) => native.streamSimple({ ...model, provider: native.id }, context, options),
  };
  const models = createModels();
  models.setProvider(provider);
  return models;
}
