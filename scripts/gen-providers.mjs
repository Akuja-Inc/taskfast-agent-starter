#!/usr/bin/env node
// Offline catalogue generation from the installed, exactly pinned pi-ai package.
// No registry queries, package installation, credentials or model requests.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

const PACKAGE = "@earendil-works/pi-ai";
const root = new URL("../", import.meta.url);
const OUT = new URL("providers.json", root);
const pins = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).dependencies;
const entry = import.meta.resolve(`${PACKAGE}/models`);
const installed = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8"));
if (pins[PACKAGE] !== installed.version || !/^\d+\.\d+\.\d+$/.test(pins[PACKAGE] ?? "")) {
  throw new Error("Install the exact pi-ai pin before regenerating the catalogue");
}
const ALIASES = { gateway: "vercel-ai-gateway", togetherai: "together" };
const FEATURED = ["anthropic", "openai", "google", "moonshotai", "xai", "deepseek", "mistral", "groq", "openrouter", "ollama", "gateway"];
// The former catalogue is a fixed baseline, not a list inferred from the last run.
const FORMER = ["anthropic", "openai", "google", "moonshotai", "xai", "deepseek", "mistral", "groq", "openrouter", "ollama", "gateway", "alibaba", "amazon-bedrock", "anthropic-aws", "azure", "baseten", "cerebras", "cohere", "deepinfra", "fireworks", "gmicloud", "google-vertex", "huggingface", "minimax", "togetherai", "zai"];
const REMOVED = {
  alibaba: "No native Alibaba provider in the pinned package; Qwen Token Plan is a different service.",
  "anthropic-aws": "No native Anthropic-on-AWS provider; Amazon Bedrock is a different endpoint and account flow.",
  cohere: "No native Cohere provider in the pinned package.",
  deepinfra: "No native DeepInfra provider in the pinned package.",
  gmicloud: "No native GMI Cloud provider in the pinned package.",
};
const REMOVED_SETTINGS = {
  "anthropic:ANTHROPIC_BASE_URL": "Native Anthropic uses its catalog endpoint, not this override.",
  "openai:OPENAI_BASE_URL": "Native OpenAI uses its catalog endpoint, not this override.",
  "google:GOOGLE_GENERATIVE_AI_API_KEY": "Use GEMINI_API_KEY.",
  "gateway:VERCEL_DEPLOYMENT_ID": "Standalone setup uses AI_GATEWAY_API_KEY; deployment OIDC is not supported.",
  "gateway:VERCEL_ENV": "Standalone setup uses AI_GATEWAY_API_KEY; deployment OIDC is not supported.",
  "gateway:VERCEL_PROJECT_ID": "Standalone setup uses AI_GATEWAY_API_KEY; deployment OIDC is not supported.",
  "gateway:VERCEL_REGION": "Standalone setup uses AI_GATEWAY_API_KEY; deployment OIDC is not supported.",
  "amazon-bedrock:AWS_ENDPOINT_URL": "The native provider selects endpoints from its catalog/region.",
  "azure:AZURE_API_KEY": "Use AZURE_OPENAI_API_KEY.",
  "azure:AZURE_RESOURCE_NAME": "Use AZURE_OPENAI_RESOURCE_NAME or AZURE_OPENAI_BASE_URL.",
  "google-vertex:GOOGLE_VERTEX_LOCATION": "Use GOOGLE_CLOUD_LOCATION.",
  "google-vertex:GOOGLE_VERTEX_PROJECT": "Use GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT.",
  "google-vertex:GOOGLE_VERTEX_API_KEY": "Use GOOGLE_CLOUD_API_KEY, or project/location plus ADC.",
  "huggingface:HUGGINGFACE_API_KEY": "Use HF_TOKEN.",
};
const NOTES = {
  anthropic: "API key, existing bearer/OAuth token, or workload identity environment settings. Setup does not log in or refresh OAuth tokens.",
  azure: "Set AZURE_OPENAI_API_KEY and AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME. Models may be Azure deployment names. Uses native Responses/Completions catalog APIs; legacy deployment URLs are not supported.",
  "amazon-bedrock": "Bearer token, AWS profile, access key pair, ECS task role, or web identity. Configure AWS_REGION/AWS_DEFAULT_REGION if needed; catalog region defaults otherwise apply. Setup does not create cloud credentials.",
  "google-vertex": "Google Cloud API key, or project/location plus ADC: run gcloud auth application-default login or set GOOGLE_APPLICATION_CREDENTIALS to a service-account file. No key is needed with ADC.",
  google: "Uses GEMINI_API_KEY (not GOOGLE_GENERATIVE_AI_API_KEY).",
  zai: "Z.ai Coding Plan global endpoint, not the general API billing endpoint.",
  minimax: "Global endpoint; minimax-cn is the separate China endpoint.",
  "github-copilot": "Requires an existing COPILOT_GITHUB_TOKEN; enable the desired model in Copilot. Setup does not perform subscription login.",
};
// Probe the installed provider's side-effect-free environment resolver. Explore
// both present/absent branches with synthetic values; never read the host env.
async function authSettings(provider) {
  const resolve = provider.auth.apiKey?.resolve;
  if (!resolve) return [];
  const names = new Set();
  const queue = [new Map()];
  const seen = new Set();
  while (queue.length) {
    const assignments = queue.shift();
    const key = JSON.stringify([...assignments].sort());
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > 4096) throw new Error(`Auth discovery exceeded its bound: ${provider.id}`);
    const path = new Map(assignments);
    await resolve({
      signal: new AbortController().signal,
      ctx: {
        fileExists: async () => true,
        env: async (name) => {
          names.add(name);
          if (!path.has(name)) {
            queue.push(new Map([...path, [name, true]]));
            path.set(name, false);
          }
          return path.get(name) ? "catalogue-probe" : undefined;
        },
      },
    });
  }
  return [...names].sort();
}
// Request-time configuration is distinct from provider auth. These module reads
// supplement the resolver probe with the cloud adapters' actual config names.
function configSettings(nativeId) {
  const files = nativeId === "azure" ? ["azure-openai-config"] : nativeId === "amazon-bedrock" ? ["bedrock-converse-stream"] : [];
  return files.flatMap((file) => {
    const src = readFileSync(new URL(`api/${file}.js`, entry), "utf8");
    return [...src.matchAll(/getProviderEnvValue\("([A-Z0-9_]+)"/g)].map((m) => m[1]).filter((name) => /^(AWS_|AZURE_)/.test(name));
  });
}
// Default prompt policy and alternative environment groups. The setting names
// themselves are discovered above and checked before anything is generated.
function authPolicy(id, names) {
  switch (id) {
    case "anthropic": return { required: ["ANTHROPIC_API_KEY"], alternatives: [["ANTHROPIC_AUTH_TOKEN"], ["ANTHROPIC_OAUTH_TOKEN"], ["ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE"]] };
    case "azure": return { required: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL"], alternatives: [["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_RESOURCE_NAME"]] };
    case "google-vertex": return { required: ["GOOGLE_CLOUD_API_KEY"], alternatives: [["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"], ["GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"], ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"], ["GOOGLE_APPLICATION_CREDENTIALS", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"]] };
    case "amazon-bedrock": return { required: ["AWS_BEARER_TOKEN_BEDROCK"], alternatives: [["AWS_PROFILE"], ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"], ["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"], ["AWS_CONTAINER_CREDENTIALS_FULL_URI"], ["AWS_WEB_IDENTITY_TOKEN_FILE"]] };
    default: return { required: names, alternatives: [] };
  }
}
const out = [];
const unsupported = Object.entries(REMOVED).map(([id, reason]) => ({ id, reason }));
for (const provider of builtinProviders()) {
  if (!provider.getModels().length || !provider.auth.apiKey) {
    unsupported.push({ id: provider.id, reason: !provider.getModels().length ? "No tool-calling chat catalog." : "Requires OAuth credential storage/login; fresh setup supports environment/ambient auth only." });
    continue;
  }
  const nativeId = provider.id;
  const module = `${PACKAGE}/providers/${nativeId}`;
  const exports = await import(module);
  const factory = Object.entries(exports).find(([name, value]) => name.endsWith("Provider") && typeof value === "function" && value().id === nativeId)?.[0];
  if (!factory) throw new Error(`No native factory export for ${nativeId}`);
  const names = [...new Set([...await authSettings(provider), ...configSettings(nativeId)])].sort();
  const policy = authPolicy(nativeId, names);
  for (const name of [...policy.required, ...policy.alternatives.flat()]) {
    if (!names.includes(name)) throw new Error(`Setup policy uses an undiscovered setting: ${nativeId}:${name}`);
  }
  const models = provider.getModels().filter((m) => m.input.includes("text")).map((m) => m.id);
  if (!models.length) throw new Error(`No text chat catalog for ${nativeId}`);
  const p = {
    id: nativeId, nativeId, package: PACKAGE, export: factory, version: installed.version,
    label: provider.name,
    settings: names.map((name) => ({ name, required: policy.required.includes(name), description: /KEY|TOKEN|SECRET|PASSWORD/.test(name) ? "credential" : "provider configuration" })),
    authAlternatives: policy.alternatives,
    models, defaultModel: models[0],
    ...(NOTES[nativeId] ? { note: NOTES[nativeId] } : {}),
  };
  out.push(p);
  for (const [alias, canonical] of Object.entries(ALIASES)) if (canonical === nativeId) out.push({ ...p, id: alias, label: `${p.label} (${alias})` });
}
out.push({ id: "ollama", nativeId: "ollama", package: PACKAGE, export: "createProvider", version: installed.version, label: "Ollama (models on your machine)", settings: [
  { name: "OLLAMA_BASE_URL", required: false, description: "OpenAI API root, default http://127.0.0.1:11434/v1" },
  { name: "OLLAMA_API_KEY", required: false, description: "Optional credential for an authenticated proxy" },
], authAlternatives: [], models: [], defaultModel: "", note: "Install/start Ollama and pull a tool-capable model first. Type its exact model id (including tags). Uses the OpenAI-compatible /v1 API, not Ollama's native chat API; no key required locally. Custom models use conservative text-only, non-reasoning metadata, 32768 context and 4096 output tokens; actual server/model limits may be lower." });
const rank = (p) => FEATURED.includes(p.id) ? FEATURED.indexOf(p.id) : FEATURED.length;
out.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
const previous = JSON.parse(readFileSync(OUT, "utf8")).providers;
const losses = [];
for (const p of previous) {
  const next = out.find((n) => n.id === p.id);
  if (!next) {
    if (!REMOVED[p.id]) losses.push(`provider ${p.id}`);
    continue;
  }
  for (const s of p.settings) if (!next.settings.some((n) => n.name === s.name) && !REMOVED_SETTINGS[`${p.id}:${s.name}`]) losses.push(`setting ${p.id}:${s.name}`);
}
if (losses.length) throw new Error(`Catalogue not written; record intended removals first: ${losses.join(", ")}`);
const generated = { generatedBy: "scripts/gen-providers.mjs", package: PACKAGE, version: installed.version, modelsFrom: "installed pi-ai chat catalog (tool calling only)", providers: out, unsupported };
const core = ["// Generated by scripts/gen-providers.mjs; do not edit.", 'import type { Provider } from "@earendil-works/pi-ai/models";', "", "export interface ProviderSource {", "  package: string;", "  export: string;", "  version: string;", "  nativeId: string;", "  create: (() => Promise<Provider>) | null;", "}", "", "export const PROVIDERS: Readonly<Record<string, ProviderSource>> = {"];
for (const p of out) core.push(`  ${JSON.stringify(p.id)}: { package: ${JSON.stringify(PACKAGE)}, export: ${JSON.stringify(p.export)}, version: ${JSON.stringify(p.version)}, nativeId: ${JSON.stringify(p.nativeId)}, create: ${p.id === "ollama" ? "null" : `async () => (await import(${JSON.stringify(`${PACKAGE}/providers/${p.nativeId}`)})).${p.export}()`} },`);
core.push("};", "");
const docs = ["# Providers", "", `Fresh setup uses the installed \`${PACKAGE}@${installed.version}\` package. It never installs provider packages or converts old agent files/settings. The tables below replace the older README provider instructions for this migration.`, "", "Run `node scripts/gen-providers.mjs` after installing the exact package pin. Generation is offline: factory exports, environment auth resolvers, cloud adapter configuration and tool-calling chat catalogs come from that installed version. Unexpected provider/setting losses fail before writes. Prompt defaults and recorded removals live in the generator. Suggested models are the first text chat entry in the pinned catalog, not a claim about release date. Image/classifier entries are not offered.", "", "## Setup and auth", "", "Use `--provider <id> --set NAME --model <id>` and export the setting first to keep credentials out of shell history. Every setup question still has a flag. A supported provider and all supplied flags/settings/model IDs are checked before `.env`, agent files, or TaskFast initialization changes. `.env` is kept private (0600), and values are not logged. Other settings already in `.env` are left alone.", "", "Required settings below describe the default prompt path. Alternative complete groups skip those prompts; a partial alternative supplied with `--set` selects that group and asks for its missing fields. Existing shell values and `.env` are accepted. Keep shell-only settings available to the agents host, or use `--set NAME` to save them. Vertex ADC additionally needs an existing credentials file/default gcloud login. Cloud auth is not provisioned or checked against a live service by setup.", "", "OAuth login, persistent OAuth credentials and refresh are not part of fresh setup. A separate pi-ai CLI `auth.json` is not loaded here. Only the environment token choices listed below work without adding credential storage. Native model IDs must be in the pinned chat catalog, except Azure deployment names. Valid model IDs may still need account access. Ollama accepts arbitrary pulled model IDs, including colon tags, with conservative metadata described in its note.", "", "## Former catalogue: explicit support status", "", "| Former ID | Status |", "| --- | --- |"];
for (const id of FORMER) docs.push(`| \`${id}\` | ${REMOVED[id] ? `Unsupported: ${REMOVED[id]}` : id === "ollama" ? "Supported via pi-ai createProvider + lazy OpenAI Completions implementation." : ALIASES[id] ? `Supported alias for \`${ALIASES[id]}\`.` : id === "zai" ? "Supported only for the native Z.ai Coding Plan global endpoint." : "Supported native provider."} |`);
docs.push("", "## Changed or removed settings", "", "No setting conversion is performed. Old variable names are refused by `--set` for the selected provider.", "", "| Former setting | Replacement / reason |", "| --- | --- |");
for (const [name, reason] of Object.entries(REMOVED_SETTINGS)) docs.push(`| \`${name}\` | ${reason} |`);
docs.push("", "## Current provider choices", "", "All entries share the package pin above. Aliases retain their ID in agent files and model lookup. Optional settings are listed in `providers.json`.", "", "| ID | Default required settings | Alternatives / notes |", "| --- | --- | --- |");
for (const p of out) docs.push(`| \`${p.id}\` | ${p.settings.filter((s) => s.required).map((s) => `\`${s.name}\``).join(", ") || "None"} | ${[...p.authAlternatives.map((group) => group.map((s) => `\`${s}\``).join(" + ")), p.note ?? ""].filter(Boolean).join("; ")} |`);
docs.push("", "## Other unsupported native entries", "");
for (const p of unsupported.filter((p) => !FORMER.includes(p.id))) docs.push(`- \`${p.id}\`: ${p.reason}`);
docs.push("", "Unknown providers are refused rather than treated as package names. There is no dynamic package installation or arbitrary provider module loading.", "");
writeFileSync(OUT, `${JSON.stringify(generated, null, 2)}\n`);
writeFileSync(new URL("src/core/providers.ts", root), core.join("\n"));
mkdirSync(new URL("docs/", root), { recursive: true });
writeFileSync(new URL("docs/providers.md", root), docs.join("\n"));
console.error(`Wrote ${out.length} provider choices from ${PACKAGE}@${installed.version}`);
