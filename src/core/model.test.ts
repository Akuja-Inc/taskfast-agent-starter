import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadModel } from "./model.js";

// A project holding one fake package whose index.js is `source` (ESM). A fake
// provider's languageModel returns { provider: <label>, modelId }.
function project(name: string, source: string): string {
  const root = mkdtempSync(join(tmpdir(), "model-"));
  const pkg = join(root, "node_modules", ...name.split("/"));
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(pkg, "index.js"), source);
  return root;
}
const fake = (label: string) => `{ languageModel: (modelId) => ({ provider: "${label}", modelId }) }`;
const anchor = (root: string) => join(root, "package.json");

// A provider builds its model without a key; the key is read on the first request.
describe("loadModel", () => {
  const saved = process.env.PERSONA_ACTORS_CLIENT;
  afterEach(() => {
    if (saved === undefined) delete process.env.PERSONA_ACTORS_CLIENT;
    else process.env.PERSONA_ACTORS_CLIENT = saved;
  });

  it.each([
    ["anthropic:claude-haiku-5-5", "anthropic", "claude-haiku-5-5"],
    ["openai:gpt-5-mini", "openai", "gpt-5-mini"],
  ])("loads %s from the project's installed @ai-sdk package", async (id, provider, modelId) => {
    delete process.env.PERSONA_ACTORS_CLIENT;
    const m = (await loadModel(id)) as { provider: string; modelId: string };
    expect(m.provider).toContain(provider);
    expect(m.modelId).toBe(modelId);
  });

  // F1: the runtime's working directory is not the project; the generated client is.
  it("resolves from the project PERSONA_ACTORS_CLIENT points into, not the working directory", async () => {
    const root = project("@ai-sdk/elsewhere", `export const elsewhere = ${fake("elsewhere")};`);
    process.env.PERSONA_ACTORS_CLIENT = pathToFileURL(join(root, "generated", "index.js")).href;
    expect(await loadModel("elsewhere:m1")).toEqual({ provider: "elsewhere", modelId: "m1" });
  });

  it("names the package to install for a provider that is not installed", async () => {
    await expect(loadModel("nosuch:some-model", anchor(project("@ai-sdk/other", "export {};")))).rejects.toThrow("pnpm setup-agent`, or `pnpm add @ai-sdk/nosuch");
  });

  // F3: the same grammar as parseAgentSpec, which owns it (spec.ts splitModel).
  it.each(["Anthropic:x", "../evil:x", "@scope/x:y", ":x", "no-colon", "anthropic:", "anthropic:a b"])("refuses the model id %s", async (id) => {
    await expect(loadModel(id)).rejects.toThrow(/provider:model/);
  });

  // F2/F5: the export line of @ai-sdk/amazon-bedrock 5.0.113 (dist/index.js), verbatim:
  // `export { VERSION, amazonBedrock, amazonBedrock as bedrock, createAmazonBedrock };`
  // No export is named "amazon-bedrock"; providers.ts declares amazonBedrock.
  it("loads @ai-sdk/amazon-bedrock through the export providers.ts names", async () => {
    const root = project(
      "@ai-sdk/amazon-bedrock",
      `const VERSION = "5.0.113";\nconst amazonBedrock = ${fake("amazon-bedrock")};\nfunction createAmazonBedrock() { return amazonBedrock; }\nexport { VERSION, amazonBedrock, amazonBedrock as bedrock, createAmazonBedrock };`,
    );
    expect(await loadModel("amazon-bedrock:anthropic.claude-3-5-sonnet-20240620-v1:0", anchor(root))).toEqual({ provider: "amazon-bedrock", modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0" });
  });

  it("loads a community provider from the package providers.ts names", async () => {
    const root = project("ollama-ai-provider-v2", `export const ollama = ${fake("ollama")};\nexport function createOllama() {}`);
    expect(await loadModel("ollama:qwen3:8b", anchor(root))).toEqual({ provider: "ollama", modelId: "qwen3:8b" });
    await expect(loadModel("openrouter:x", anchor(root))).rejects.toThrow("pnpm add @openrouter/ai-sdk-provider");
  });

  // F5: no guessing. Without its declared export, a package is refused, even when it
  // has exactly one provider under another name.
  it.each([
    ["one provider under another name", `export const elsewise = ${fake("elsewise")};`],
    ["no provider", "export function createBare() {}"],
  ])("refuses an @ai-sdk package with %s", async (_why, source) => {
    await expect(loadModel("bare:x", anchor(project("@ai-sdk/bare", source)))).rejects.toThrow('@ai-sdk/bare has no provider export "bare"');
  });
});
