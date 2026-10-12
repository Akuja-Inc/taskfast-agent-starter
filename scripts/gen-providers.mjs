#!/usr/bin/env node
// Regenerates providers.json, the provider menu of `pnpm setup-agent`, and
// src/core/providers.ts: every AI SDK provider package with a default text-model
// provider, plus two community providers. It needs the network.
//
//   node scripts/gen-providers.mjs
//
// For each package it records the exact version inspected (setup installs that
// version), the settings it reads from the environment (from its loadApiKey,
// loadSetting and loadOptionalSetting calls), and its models: the tool-calling text
// models models.dev lists for it, newest first, then the ids its default provider's
// languageModel() type also accepts. The suggested model is derived (modelMenu), not
// hand-picked. What the code cannot see sits in the tables below.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";

const OUT = new URL("../providers.json", import.meta.url);
// The package and export core/model.ts binds for each id.
const CORE_OUT = new URL("../src/core/providers.ts", import.meta.url);
// The kit's own pins. A provider the kit depends on (anthropic, openai) is inspected at
// its pinned version, so the catalogue describes what is installed (review F7); the kit
// test checks the two agree.
const KIT_PINS = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies;

// Community providers from ai-sdk.dev, by id.
const COMMUNITY = { openrouter: "@openrouter/ai-sdk-provider", ollama: "ollama-ai-provider-v2" };

// Shown first, in this order; the rest follow by label.
const FEATURED = ["anthropic", "openai", "google", "moonshotai", "xai", "deepseek", "mistral", "groq", "openrouter", "ollama", "gateway"];

const LABELS = {
  anthropic: "Anthropic (Claude)",
  "anthropic-aws": "Anthropic on AWS",
  openai: "OpenAI (GPT)",
  google: "Google (Gemini)",
  "google-vertex": "Google Vertex AI",
  moonshotai: "Moonshot AI (Kimi)",
  xai: "xAI (Grok)",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  groq: "Groq",
  openrouter: "OpenRouter (many providers, one key)",
  ollama: "Ollama (models on your machine)",
  gateway: "Vercel AI Gateway (many providers, one key)",
  "amazon-bedrock": "Amazon Bedrock",
  azure: "Azure OpenAI",
  togetherai: "Together AI",
  deepinfra: "DeepInfra",
  huggingface: "Hugging Face",
  minimax: "MiniMax",
  zai: "Z.ai (GLM)",
  gmicloud: "GMI Cloud",
  bytedance: "ByteDance",
};

// Packages whose models.dev entry has another id (matched by npm package first).
const MODELS_DEV_ID = { fireworks: "fireworks-ai", "anthropic-aws": "anthropic" };

// Text-to-image and SVG generators: they expose languageModel() but cannot run an
// agent's tool calls, and models.dev has no entry to show it.
const EXCLUDE = { prodia: "image generation", quiverai: "SVG generation" };

const NOTES = {
  azure: "The model is your Azure deployment name.",
  "amazon-bedrock": "Instead of an access key, a Bedrock API key in AWS_BEARER_TOKEN_BEDROCK also works.",
  "google-vertex": "Also needs Google credentials: run `gcloud auth application-default login`, or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key file.",
  ollama: "Runs models on your machine: install Ollama (ollama.com), start it, and `ollama pull <model>` first. No API key.",
  openrouter: "Model ids are creator/model; openrouter.ai/models lists them all.",
  gateway: "Model ids are creator/model; vercel.com/ai-gateway/models lists them all.",
};

const tmp = mkdtempSync(join(tmpdir(), "providers-"));
const npm = (...args) => execFileSync("npm", args, { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function officialNames() {
  const headers = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const res = await fetch("https://api.github.com/repos/vercel/ai/contents/packages", { headers });
  if (!res.ok) throw new Error(`GitHub: ${res.status} ${await res.text()}`);
  return (await res.json()).filter((e) => e.type === "dir").map((e) => e.name);
}

// Target the provider spec that ai@7 uses (@ai-sdk/provider 4.x).
function compatible(meta) {
  const dep = meta.dependencies?.["@ai-sdk/provider"];
  if (dep) return /^[\^~]?4\./.test(dep);
  return /\^7\./.test(meta.peerDependencies?.ai ?? "");
}

function unpack(pkg, version) {
  const [{ filename }] = JSON.parse(npm("pack", `${pkg}@${version}`, "--json", "--silent"));
  const dir = join(tmp, filename.replace(/\.tgz$/, ""));
  execFileSync("mkdir", ["-p", dir]);
  execFileSync("tar", ["-xzf", join(tmp, filename), "-C", dir]);
  return join(dir, "package");
}

function entryTypes(root) {
  const p = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const e = p.exports?.["."] ?? p.exports;
  const pick = (v) => (typeof v === "string" ? v : v && (v.types ?? pick(v.import) ?? pick(v.default)));
  const t = (e && typeof e === "object" && (e.types ?? pick(e.import) ?? pick(e.require))) || p.types || p.typings;
  if (!t) throw new Error("no type declarations");
  return join(root, t);
}

// The exported provider instances that have languageModel(), and the model ids it takes.
function instances(dts) {
  const program = ts.createProgram([dts], { types: [], skipLibCheck: true, noEmit: true });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(dts);
  const mod = sf && checker.getSymbolAtLocation(sf);
  if (!mod) return [];
  const seen = new Map();
  for (const exp of checker.getExportsOfModule(mod)) {
    const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
    if (!(sym.flags & ts.SymbolFlags.Variable)) continue;
    // One object exported under several names (deepSeek and deepseek): keep every name.
    if (seen.has(sym)) {
      seen.get(sym).names.push(exp.name);
      continue;
    }
    const type = checker.getTypeOfSymbolAtLocation(sym, sf);
    const lm = type.getProperty("languageModel");
    if (!lm) continue;
    const models = new Set();
    for (const sig of checker.getTypeOfSymbolAtLocation(lm, sf).getCallSignatures()) {
      const param = sig.getParameters()[0];
      if (!param) continue;
      const t = checker.getTypeOfSymbolAtLocation(param, sf);
      for (const m of t.isUnion() ? t.types : [t]) if (m.isStringLiteral()) models.add(m.value);
    }
    seen.set(sym, { names: [exp.name], models: [...models] });
  }
  return [...seen.values()];
}

// The main entry's JS (what core/model.ts imports) and the files it imports relatively.
// Subpath entries such as @ai-sdk/google-vertex/edge read other settings and are skipped.
function entryJs(root) {
  const p = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const e = p.exports?.["."] ?? p.exports;
  const pick = (v) => (typeof v === "string" ? v : v && (pick(v.import) ?? pick(v.default) ?? pick(v.node)));
  const start = join(root, (e && typeof e === "object" ? pick(e.import) ?? pick(e.default) : e) ?? p.module ?? p.main ?? "index.js");
  const files = new Set();
  const visit = (f) => {
    if (files.has(f) || !existsSync(f)) return;
    files.add(f);
    for (const m of readFileSync(f, "utf8").matchAll(/(?:from\s*|import\s*\(\s*|require\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) visit(join(dirname(f), m[1]));
  };
  visit(start);
  return [...files];
}

// Settings the package must have to run, beyond what its loaders mark required.
// AI Gateway reads its key as optional because a Vercel deployment can use OIDC
// instead; run anywhere else, it needs the key.
const REQUIRED = { gateway: ["AI_GATEWAY_API_KEY"] };

// The text of the object literal that opens at src[open] ("{"), up to its matching "}".
function objectAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return "";
}

// Settings read through @ai-sdk/provider-utils' loaders, by environment variable. Each
// loader call's whole options object is read, however long (F8).
function settings(root, id) {
  const found = new Map();
  for (const f of entryJs(root)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/load(ApiKey|Setting|OptionalSetting)\(\s*\{/g)) {
      const options = objectAt(src, m.index + m[0].length - 1);
      const name = options.match(/environmentVariableName:\s*["']([A-Z0-9_]+)["']/)?.[1];
      if (!name) continue;
      const description = options.match(/description:\s*["']([^"']*)["']/)?.[1] ?? found.get(name)?.description ?? "";
      const required = m[1] !== "OptionalSetting" || found.get(name)?.required === true;
      found.set(name, { name, required, description });
    }
  }
  for (const name of REQUIRED[id] ?? []) found.set(name, { ...(found.get(name) ?? { name, description: "" }), required: true });
  return [...found.values()].sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
}

// An agent runs on tool calls, so only models.dev models with tool_call and text in and
// out count, and none marked beta, alpha or deprecated.
const usable = (m) => m.tool_call === true && m.modalities?.input?.includes("text") && m.modalities?.output?.includes("text") && !m.status;

// models.dev's entry for a package: same npm package (and id, if several), else by id.
function modelsDevEntry(md, id, pkg) {
  const byNpm = Object.values(md).filter((p) => p.npm === pkg);
  return byNpm.find((p) => p.id === id) ?? (byNpm.length === 1 ? byNpm[0] : undefined) ?? md[MODELS_DEV_ID[id] ?? id];
}

// Who made a model, from models.dev's canonical_model_id ("mistral/mistral-large-4").
const maker = (m) => m.canonical_model_id?.split("/")[0];

// The menu, newest first: models.dev's usable models with a known maker, then its other
// usable models (anonymous and preview models on aggregators), then ids only the
// package's types list. The default is the newest usable model, cheaper first on the same day,
// taken from the first of these that is not empty:
//   1. the provider's own models (maker is the provider, or its id's first word:
//      Mistral suggests a Mistral model, not a GLM model it also serves, and Google
//      Vertex a Gemini model);
//   2. models models.dev traces to a maker (this drops anonymous and preview models
//      on aggregators such as OpenRouter);
//   3. any usable model.
// No hand-picked defaults: they go stale.
function modelMenu(entry, typeIds, id) {
  if (!entry) return { models: typeIds, defaultModel: "" };
  const all = Object.values(entry.models ?? {}).filter(usable);
  const newest = (a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? "") || (a.cost?.input ?? Infinity) - (b.cost?.input ?? Infinity) || a.id.localeCompare(b.id);
  const sorted = [...all].sort(newest);
  // google-vertex's own models are google's; amazon-bedrock's are amazon's.
  const own = sorted.filter((m) => [id, entry.id, id.split("-")[0]].includes(maker(m)));
  const traced = sorted.filter((m) => maker(m));
  const ids = [...traced, ...sorted.filter((m) => !maker(m))].map((m) => m.id);
  return { models: [...ids, ...typeIds.filter((t) => !ids.includes(t))], defaultModel: (own[0] ?? traced[0] ?? sorted[0])?.id ?? "", usable: all.length };
}

// Every skip above only logs, so a run can lose a provider (a package moves to the next
// provider spec, a download fails) or a setting (a loader call the scrape misses). The
// catalogue in the tree is the floor: a run that drops a provider or a setting it has
// writes nothing and exits 1 (F8), unless the drop is recorded here, with the reason.
const REMOVED = {};
const REMOVED_SETTINGS = {};

function previous() {
  try {
    return JSON.parse(readFileSync(OUT, "utf8")).providers;
  } catch {
    return [];
  }
}

// What the new catalogue drops from the old one, as readable lines.
function losses(old, next) {
  const now = new Map(next.map((p) => [p.id, new Set(p.settings.map((s) => s.name))]));
  const lines = [];
  for (const p of old) {
    if (REMOVED[p.id]) continue;
    const kept = now.get(p.id);
    if (!kept) {
      lines.push(`provider ${p.id} (${p.package})`);
      continue;
    }
    for (const s of p.settings) if (!kept.has(s.name) && !REMOVED_SETTINGS[`${p.id}:${s.name}`]) lines.push(`setting ${s.name} of ${p.id}`);
  }
  return lines;
}

async function main() {
  const md = await (await fetch("https://models.dev/api.json")).json();
  const candidates = [...(await officialNames()).map((n) => [n, `@ai-sdk/${n}`]), ...Object.entries(COMMUNITY)];
  const out = [];
  for (const [id, pkg] of candidates) {
    if (EXCLUDE[id]) {
      console.error(`skip ${pkg}: ${EXCLUDE[id]}`);
      continue;
    }
    let meta;
    try {
      meta = JSON.parse(npm("view", KIT_PINS[pkg] ? `${pkg}@${KIT_PINS[pkg]}` : pkg, "version", "dependencies", "peerDependencies", "--json"));
    } catch {
      console.error(`skip ${pkg}: not published`);
      continue;
    }
    if (!compatible(meta)) {
      console.error(`skip ${pkg}@${meta.version}: not built for ai@7 (@ai-sdk/provider 4)`);
      continue;
    }
    let root, dts;
    try {
      root = unpack(pkg, meta.version);
      dts = entryTypes(root);
    } catch (e) {
      console.error(`skip ${pkg}: ${e.message}`);
      continue;
    }
    const inst = instances(dts);
    if (!inst.length) {
      console.error(`skip ${pkg}: no default provider with languageModel()`);
      continue;
    }
    // The export named after the id, else the only one; recorded in src/core/providers.ts
    // so core/model.ts binds it by name.
    const chosen = inst.find((i) => i.names.includes(id)) ?? (inst.length === 1 ? inst[0] : null);
    if (!chosen) {
      console.error(`skip ${pkg}: several providers (${inst.map((i) => i.names.join("/")).join(", ")})`);
      continue;
    }
    chosen.name = chosen.names.includes(id) ? id : chosen.names[0];
    const mdEntry = modelsDevEntry(md, id, pkg);
    const menu = modelMenu(mdEntry, chosen.models, id);
    if (mdEntry && menu.usable === 0) {
      console.error(`skip ${pkg}: models.dev lists no tool-calling text model`);
      continue;
    }
    const entry = { id, package: pkg, export: chosen.name, version: meta.version, label: LABELS[id] ?? id, settings: settings(root, id), models: menu.models, defaultModel: menu.defaultModel };
    if (NOTES[id]) entry.note = NOTES[id];
    out.push(entry);
    console.error(`ok   ${pkg}@${meta.version}: ${menu.models.length} models (models.dev: ${mdEntry?.id ?? "none"}), default ${menu.defaultModel || "none"}, settings ${entry.settings.map((s) => (s.required ? s.name : `(${s.name})`)).join(" ") || "none"}`);
  }
  const rank = (p) => (FEATURED.includes(p.id) ? FEATURED.indexOf(p.id) : FEATURED.length);
  out.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  const lost = losses(previous(), out);
  if (lost.length) {
    console.error(`\nnot written: this run would drop what the current catalogue has:\n  ${lost.join("\n  ")}\nIf a drop is intended, add the provider to REMOVED (or the setting to REMOVED_SETTINGS) with the reason, and run again.`);
    process.exitCode = 1;
    return;
  }
  const generatedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(OUT, `${JSON.stringify({ generatedBy: "scripts/gen-providers.mjs", generatedAt, modelsFrom: "https://models.dev/api.json", providers: out }, null, 2)}\n`);
  const core = out
    .filter((p) => p.package !== `@ai-sdk/${p.id}` || p.export !== p.id)
    .map((p) => `  ${JSON.stringify(p.id)}: { package: ${JSON.stringify(p.package)}, export: ${JSON.stringify(p.export)} },`);
  writeFileSync(
    CORE_OUT,
    [
      "// Generated by scripts/gen-providers.mjs; do not edit. Regenerate it with the",
      "// starter kit's providers.json.",
      "//",
      "// The providers whose package or export is not the default: a model id",
      '// "<id>:<model>" loads export <id> of @ai-sdk/<id> unless <id> is listed here.',
      "export const PROVIDERS: Readonly<Record<string, { package: string; export: string }>> = {",
      ...core,
      "};",
      "",
    ].join("\n"),
  );
  console.error(`wrote ${out.length} providers to providers.json`);
}

try {
  await main();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
