import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, type Models, type Provider } from "@earendil-works/pi-ai/models";
import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PROVIDERS, type ProviderSource } from "./providers.js";
import { splitModel } from "./spec.js";
import { CREDENTIAL_FILES, folderFile } from "./folder.js";

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
export async function createAgentModels(id: string, scope?: { agentDir: string; settings: Readonly<Record<string, string>> }): Promise<Models> {
  const { provider: name, modelId } = splitModel(id);
  const source = providerSource(name);
  if (scope && name === "amazon-bedrock" && !scope.settings.AWS_BEARER_TOKEN_BEDROCK) {
    throw new Error("folder-scoped Bedrock requires AWS_BEARER_TOKEN_BEDROCK; ambient AWS credential chains are not isolated by the pinned provider");
  }
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
  const settings = scope ? { ...scope.settings } : undefined;
  if (settings) for (const name of CREDENTIAL_FILES) {
    const value = settings[name];
    if (value) {
      settings[name] = folderFile({ agentDir: scope?.agentDir ?? ".", path: value, resource: name });
    }
  }
  const scopedOptions = (model: Model<Api>, options?: StreamOptions): StreamOptions | undefined => {
    if (!settings) return options;
    // The pinned native env helper uses truthy overrides, then process.env.
    // Refuse an undeclared ambient value rather than sending a private key to
    // its endpoint or silently taking machine-level configuration.
    for (const key of source.envNames) {
      if (process.env[key] && !settings[key]) throw new Error(`folder-scoped provider refuses ambient ${key}; supply an agent-local setting or unset it in the host`);
    }
    // These SDK defaults bypass pi-ai's scoped env entirely; even an equal
    // agent-local value cannot safely neutralize their machine-level lookup.
    const sdkNames = model.api.startsWith("openai-") || model.api.startsWith("azure-")
      ? ["OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "OPENAI_CUSTOM_HEADERS", "OPENAI_ADMIN_KEY", "OPENAI_WEBHOOK_SECRET", "OPENAI_LOG"]
      : model.api === "google-generative-ai" || model.api === "google-vertex" ? ["GOOGLE_GEMINI_BASE_URL", "GOOGLE_VERTEX_BASE_URL", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_ENTERPRISE"]
      : model.api === "anthropic-messages" ? ["ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_WEBHOOK_SIGNING_KEY", "ANTHROPIC_LOG"]
      : model.api === "bedrock-converse-stream" ? ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_USE_FIPS_ENDPOINT", "AWS_USE_DUALSTACK_ENDPOINT", "AWS_AUTH_SCHEME_PREFERENCE", "AWS_MAX_ATTEMPTS", "AWS_RETRY_MODE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE"] : [];
    for (const key of [...sdkNames, "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
      if (process.env[key]) throw new Error(`folder-scoped provider refuses SDK ambient ${key}; unset it in the host`);
    }
    if (name === "amazon-bedrock" && ["config", "credentials"].some((file) => existsSync(join(homedir(), ".aws", file)))) throw new Error("folder-scoped Bedrock refuses machine-level AWS files; use a host without ambient AWS configuration");
    return { ...options, cacheRetention: options?.cacheRetention ?? "short", ...(name === "amazon-bedrock" ? { apiKey: settings.AWS_BEARER_TOKEN_BEDROCK } : {}), env: { ...settings } };
  };
  // Preserve setup aliases in lookup and model IDs while dispatching with the
  // native identity, which provider-specific protocol behavior can depend on.
  const provider: Provider = {
    ...native,
    id: name,
    getModels: chatModels,
    getAllModels: chatModels,
    stream: (model, context, options) => native.stream<Api>({ ...model, provider: native.id }, context, scopedOptions(model, options)),
    streamSimple: (model, context, options) => native.streamSimple({ ...model, provider: native.id }, context, scopedOptions(model, options)),
  };
  const models = createModels(scope && settings ? { authContext: {
    env: async (name) => settings[name],
    fileExists: async (path) => {
      try { return existsSync(folderFile({ agentDir: scope.agentDir, path, resource: "provider credential" })); }
      catch { return false; }
    },
  } } : undefined);
  models.setProvider(provider);
  return models;
}
