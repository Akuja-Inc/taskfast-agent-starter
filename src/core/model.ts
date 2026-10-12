import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LanguageModel } from "ai";
import { PROVIDERS } from "./providers.js";
import { splitModel } from "./spec.js";

type Provider = { languageModel(modelId: string): LanguageModel };

// Where provider <id> lives: export <id> of @ai-sdk/<id>, unless providers.ts (generated
// from the packages by scripts/gen-providers.mjs) names another package or export, as
// for OpenRouter, Ollama and Amazon Bedrock.
export const providerSource = (id: string): { package: string; export: string } => PROVIDERS[id] ?? { package: `@ai-sdk/${id}`, export: id };

// The agent file names its model as "provider:model", and the provider's package must
// be installed in the project (`pnpm setup-agent` installs it). Each provider reads its
// own settings from the environment (ANTHROPIC_API_KEY, MOONSHOT_API_KEY, ...).
//
// The package is resolved from the project, not from the bundle: the runtime builds
// actor code into its data directory, which may sit outside the project, where no
// node_modules is found (checked in the real runtime, 2026-10-11). The project is where
// PERSONA_ACTORS_CLIENT points (the generated client, an absolute file URL that self.ts
// already needs), else the working directory. This is one of the core's two computed
// imports (allowed by name in test/core-boundary.test.ts); spec.ts limits the provider
// id to [a-z0-9-], and the package comes from providerSource.
export const projectAnchor = (): string => process.env.PERSONA_ACTORS_CLIENT || join(process.cwd(), "package.json");

export async function loadModel(id: string, from = projectAnchor()): Promise<LanguageModel> {
  const { provider: name, modelId } = splitModel(id);
  const source = providerSource(name);
  let path: string;
  try {
    path = createRequire(from).resolve(source.package);
  } catch {
    throw new Error(`model provider "${name}" is not installed: run \`pnpm setup-agent\`, or \`pnpm add ${source.package}\` in the project (looked from ${from})`);
  }
  const provider = ((await import(pathToFileURL(path).href)) as Record<string, unknown>)[source.export] as Provider | undefined;
  if (typeof provider?.languageModel !== "function") throw new Error(`${source.package} has no provider export "${source.export}"`);
  return provider.languageModel(modelId);
}

let factory: (id: string) => Promise<LanguageModel> = (id) => loadModel(id);

export const languageModel = (id: string): Promise<LanguageModel> => factory(id);

// For tests: replace how a model id becomes a model.
export function setModelFactory(f: (id: string) => LanguageModel): void {
  factory = async (id) => f(id);
}
