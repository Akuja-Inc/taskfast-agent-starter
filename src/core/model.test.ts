import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialSetting, providerSettings } from "./folder.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { createAgentModels, providerSource } from "./model.js";
import { PROVIDERS } from "./providers.js";

const registered = async ({ id, provider, modelId }: { id: string; provider: string; modelId: string }) => {
  const models = await createAgentModels(id);
  expect(models.getProviders().map((p) => p.id)).toEqual([provider]);
  const model = models.getModel(provider, modelId);
  expect(model).toBeDefined();
  return { models, model };
};
afterEach(() => vi.unstubAllEnvs());

describe("createAgentModels", () => {
  it("isolates each agent's model credentials without falling back to host keys", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "host-key-must-not-be-used");
    const id = "anthropic:claude-haiku-5-5";
    const first = await createAgentModels(id, { agentDir: "/tmp/agent-one", settings: { ANTHROPIC_API_KEY: "first-private-key" } });
    const second = await createAgentModels(id, { agentDir: "/tmp/agent-two", settings: { ANTHROPIC_API_KEY: "second-private-key" } });
    const empty = await createAgentModels(id, { agentDir: "/tmp/agent-empty", settings: {} });
    const [a, b, absent] = await Promise.all([first.getAuth("anthropic"), second.getAuth("anthropic"), empty.getAuth("anthropic")]);
    expect(a?.auth.apiKey).toBe("first-private-key");
    expect(b?.auth.apiKey).toBe("second-private-key");
    expect(absent).toBeUndefined();
  });
  it("blocks native Azure host endpoint fallback before dispatching the folder's key", async () => {
    let requests = 0;
    const server = createServer((_request, response) => { requests++; response.writeHead(401); response.end('{"error":{"message":"unexpected host endpoint"}}'); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    vi.stubEnv("AZURE_OPENAI_BASE_URL", `http://127.0.0.1:${address.port}`);
    try {
      const models = await createAgentModels("azure:my-deployment", { agentDir: "/tmp/azure-agent", settings: { AZURE_OPENAI_API_KEY: "private-key", AZURE_OPENAI_RESOURCE_NAME: "private-resource" } });
      const model = models.getModel("azure", "my-deployment");
      if (!model) throw new Error("missing model");
      const result = await models.completeSimple(model, { messages: [{ role: "user", content: "Ready?", timestamp: 1 }] });
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("ambient AZURE_OPENAI_BASE_URL");
      expect(requests).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each<{ key: string; id: string; provider: string; modelId: string; settings: Record<string, string> }>([
    { key: "OPENAI_ORG_ID", id: "ollama:qwen3:8b", provider: "ollama", modelId: "qwen3:8b", settings: { OLLAMA_BASE_URL: "http://127.0.0.1:1/v1" } },
    { key: "OPENAI_CUSTOM_HEADERS", id: "ollama:qwen3:8b", provider: "ollama", modelId: "qwen3:8b", settings: { OLLAMA_BASE_URL: "http://127.0.0.1:1/v1" } },
    { key: "GOOGLE_VERTEX_BASE_URL", id: "google-vertex:gemini-2.5-flash", provider: "google-vertex", modelId: "gemini-2.5-flash", settings: { GOOGLE_CLOUD_API_KEY: "private-key" } },
  ])("refuses SDK-only ambient $key even if copied into scoped settings", async ({ key, id, provider, modelId, settings }) => {
    vi.stubEnv(key, "http://127.0.0.1:1");
    const models = await createAgentModels(id, { agentDir: "/tmp/agent", settings: { ...settings, [key]: "http://127.0.0.1:2" } });
    const model = models.getModel(provider, modelId);
    if (!model) throw new Error("missing model");
    const result = await models.completeSimple(model, { messages: [{ role: "user", content: "Ready?", timestamp: 1 }] });
    expect(result.errorMessage).toContain(`ambient ${key}`);
  });

  it("refuses ambient Bedrock credentials in folder-scoped mode", async () => {
    await expect(createAgentModels("amazon-bedrock:anthropic.claude-3-5-sonnet-20240620-v1:0", { agentDir: "/tmp/agent", settings: { AWS_PROFILE: "host-profile" } })).rejects.toThrow("folder-scoped Bedrock requires AWS_BEARER_TOKEN_BEDROCK");
  });

  it("refuses provider credential files outside the owning folder", async () => {
    await expect(createAgentModels("google-vertex:gemini-2.5-flash", { agentDir: "/tmp/agent", settings: { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/another-agent/key.json" } })).rejects.toThrow("inside the agent folder");
  });

  it("refuses escaping credential and settings symlinks without reading their targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "credential-links-"));
    const agentDir = join(root, "one");
    mkdirSync(agentDir);
    const outside = join(root, "other-key");
    writeFileSync(outside, "synthetic key");
    symlinkSync(outside, join(agentDir, "key.json"));
    symlinkSync(outside, join(agentDir, ".env"));
    try {
      expect(() => credentialSetting({ agentDir, name: "GOOGLE_APPLICATION_CREDENTIALS", value: "key.json" })).toThrow(/symlink/);
      expect(() => providerSettings(agentDir)).toThrow(/symlink/);
      await expect(createAgentModels("google-vertex:gemini-2.5-flash", { agentDir, settings: { GOOGLE_APPLICATION_CREDENTIALS: "key.json" } })).rejects.toThrow(/symlink/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ["anthropic", "claude-haiku-5-5"],
    ["openai", "gpt-5-mini"],
    ["google", "gemini-2.5-flash"],
    ["amazon-bedrock", "anthropic.claude-3-5-sonnet-20240620-v1:0"],
  ])("resolves %s chat metadata through an explicitly registered native provider", async (provider, id) => {
    const source = providerSource(provider);
    const native = await source.create?.();
    const nativeModel = native?.getModels().find((model) => model.id === id);
    // Bedrock's exact catalog IDs can change at a package pin; use a real entry.
    const selected = nativeModel?.id ?? native?.getModels()[0]?.id;
    expect(selected).toBeTruthy();
    if (!selected) throw new Error("missing catalog model");
    const { models, model } = await registered({ id: `${provider}:${selected}`, provider, modelId: selected });
    expect(model).toEqual(native?.getModels().find((m) => m.id === selected));
    expect(models.getModel("not-registered", selected)).toBeUndefined();
  });

  it("keeps the native API, costs and capability metadata, not just a model ID", async () => {
    const { model } = await registered({ id: "openai:gpt-5-mini", provider: "openai", modelId: "gpt-5-mini" });
    expect(model).toEqual(getBuiltinModel("openai", "gpt-5-mini"));
    expect(model?.api).toBe("openai-responses");
    expect(model?.contextWindow).toBeGreaterThan(0);
    expect(model?.cost.input).toBeGreaterThan(0);
  });

  it.each(["gateway", "togetherai"])("preserves the valid %s alias in lookup and environment auth", async (alias) => {
    const source = providerSource(alias);
    const native = await source.create?.();
    const first = native?.getModels()[0];
    if (!first) throw new Error("missing alias catalog");
    vi.stubEnv(alias === "gateway" ? "AI_GATEWAY_API_KEY" : "TOGETHER_API_KEY", "alias-test-key");
    const { models, model } = await registered({ id: `${alias}:${first.id}`, provider: alias, modelId: first.id });
    expect(model).toEqual({ ...first, provider: alias });
    expect((await models.getAuth(alias))?.auth.apiKey).toBe("alias-test-key");
    expect(source.nativeId).toBe(alias === "gateway" ? "vercel-ai-gateway" : "together");
  });

  it.each(["nosuch", "alibaba", "anthropic-aws", "cohere", "deepinfra", "gmicloud", "openai-codex", "typesafe", "constructor"])("refuses unsupported provider %s without package guessing", async (provider) => {
    await expect(createAgentModels(`${provider}:some-model`)).rejects.toThrow(/unsupported model provider/);
    expect(() => providerSource(provider)).toThrow(/docs\/providers.md/);
  });

  it.each(["Anthropic:x", "../evil:x", "@scope/x:y", ":x", "no-colon", "anthropic:", "anthropic:a b"])("refuses malformed id %s", async (id) => {
    await expect(createAgentModels(id)).rejects.toThrow(/provider:model/);
  });

  it("refuses unknown native model IDs and non-chat classifier IDs", async () => {
    await expect(createAgentModels("openai:not-in-the-pin")).rejects.toThrow(/unsupported model/);
    await expect(createAgentModels("openrouter:typesafe/jev-1.13")).rejects.toThrow(/unsupported model/);
    expect(() => providerSource("toString")).toThrow(/unsupported model provider/);
  });

  it("resolves arbitrary Azure deployment names conservatively", async () => {
    const { model } = await registered({ id: "azure:my-deployment", provider: "azure", modelId: "my-deployment" });
    expect(model).toMatchObject({ api: "azure-openai-responses", reasoning: false, input: ["text"], cost: { input: 0, output: 0 }, maxTokens: 4096 });
  });

  it("uses Gemini's native environment setting", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "wrong-variable");
    vi.stubEnv("GEMINI_API_KEY", "native-variable");
    const models = await createAgentModels("google:gemini-2.5-flash");
    expect((await models.getAuth("google"))?.auth.apiKey).toBe("native-variable");
  });

  it("all generated native factory bindings register their declared identity", async () => {
    for (const [id, source] of Object.entries(PROVIDERS)) {
      if (!source.create) continue;
      const native = await source.create();
      expect(native.id).toBe(source.nativeId);
      const first = native.getModels()[0];
      if (!first) throw new Error(`empty catalog: ${id}`);
      await registered({ id: `${id}:${first.id}`, provider: id, modelId: first.id });
    }
  });

  it("sends concurrent native requests with each folder's own credentials and endpoint", async () => {
    const keys: string[] = [];
    const server = createServer(async (request, response) => {
      keys.push(request.headers.authorization ?? "");
      for await (const _chunk of request) { /* drain request */ }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('data: {"id":"local","choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    vi.stubEnv("OLLAMA_API_KEY", "wrong-host-key");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:1/v1");
    try {
      const collections = await Promise.all(["one", "two"].map((name) => createAgentModels("ollama:qwen3:8b", { agentDir: `/tmp/${name}`, settings: { OLLAMA_API_KEY: name, OLLAMA_BASE_URL: `http://127.0.0.1:${address.port}/v1` } })));
      await Promise.all(collections.map(async (models) => {
        const model = models.getModel("ollama", "qwen3:8b");
        if (!model) throw new Error("missing custom model");
        expect((await models.completeSimple(model, { messages: [{ role: "user", content: "Ready?", timestamp: 1 }] })).stopReason).toBe("stop");
      }));
      expect(keys.sort()).toEqual(["Bearer one", "Bearer two"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([undefined, "proxy-test-key"])("Ollama really sends custom colon-tagged tool models through the local OpenAI API (key=%s)", async (key) => {
    let payload: unknown;
    let authorization: string | undefined;
    const server = createServer(async (request, response) => {
      authorization = request.headers.authorization;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      expect(request.url).toBe("/v1/chat/completions");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('data: {"id":"local","choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    vi.stubEnv("OLLAMA_BASE_URL", `http://127.0.0.1:${address.port}/v1`);
    vi.stubEnv("OLLAMA_API_KEY", key ?? "");
    try {
      const { models, model } = await registered({ id: "ollama:qwen3:8b", provider: "ollama", modelId: "qwen3:8b" });
      if (!model) throw new Error("missing custom model");
      const result = await models.completeSimple(model, {
        messages: [{ role: "user", content: "Ready?", timestamp: 1 }],
        tools: [{ name: "look", description: "Read marketplace", parameters: { type: "object", properties: {}, additionalProperties: false } }],
      });
      expect(result.stopReason).toBe("stop");
      expect(result.content).toContainEqual({ type: "text", text: "Ready" });
      expect(payload).toMatchObject({ model: "qwen3:8b", tools: [{ type: "function", function: { name: "look" } }] });
      expect(authorization).toBe(`Bearer ${key || "ollama"}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
