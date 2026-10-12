# Providers

Fresh setup uses the installed `@earendil-works/pi-ai@1.1.0` package. It never installs provider packages or converts old agent files/settings. The tables below replace the older README provider instructions for this migration.

Run `node scripts/gen-providers.mjs` after installing the exact package pin. Generation is offline: factory exports, environment auth resolvers, cloud adapter configuration and tool-calling chat catalogs come from that installed version. Unexpected provider/setting losses fail before writes. Prompt defaults and recorded removals live in the generator. Suggested models are the first text chat entry in the pinned catalog, not a claim about release date. Image/classifier entries are not offered.

## Setup and auth

Use `--provider <id> --set NAME --model <id>` and export the setting first to keep credentials out of shell history. Every setup question still has a flag. A supported provider and all supplied flags/settings/model IDs are checked before files or TaskFast initialization changes. Settings are saved only to `agents/<id>/.env`, kept private (0600), and values are not logged. Other settings in that agent's file are left alone; the repository's `.env` is never loaded.

Required settings below describe the default prompt path. Alternative complete groups skip those prompts; a partial alternative supplied with `--set` selects that group and asks for its missing fields. Exported required settings and the selected agent's existing `.env` are accepted and saved inside its folder. The running host does not fall back to shared model keys. The pinned native adapters can inherit missing environment settings, so dispatch refuses undeclared ambient provider settings before any request. Supply the intended agent-local setting or remove the conflicting host setting. SDK-only ambient organization/project headers, custom headers and proxy settings are refused even if copied into the agent file, because the pinned SDKs do not use scoped overrides for them. Bedrock also refuses machine-level AWS configuration files. Cache retention is set explicitly. Credential and settings paths must not traverse symlinks. Vertex ADC additionally needs a credential file placed inside that agent's folder; setup stores its relative path so it can move with the folder. Cloud auth is not provisioned or checked against a live service by setup.

OAuth login, persistent OAuth credentials and refresh are not part of fresh setup. A separate pi-ai CLI `auth.json` is not loaded here. Only the agent-local token choices listed below work without adding credential storage. Folder-scoped Bedrock supports its bearer token only: the pinned AWS adapter's ambient/profile credential chain can consult machine-level sources and is refused rather than presented as isolated. The native catalogue still lists those alternatives for explicit low-level hosts; normal setup rejects them before writing files. Native model IDs must be in the pinned chat catalog, except Azure deployment names. Valid model IDs may still need account access. Ollama accepts arbitrary pulled model IDs, including colon tags, with conservative metadata described in its note.

## Former catalogue: explicit support status

| Former ID | Status |
| --- | --- |
| `anthropic` | Supported native provider. |
| `openai` | Supported native provider. |
| `google` | Supported native provider. |
| `moonshotai` | Supported native provider. |
| `xai` | Supported native provider. |
| `deepseek` | Supported native provider. |
| `mistral` | Supported native provider. |
| `groq` | Supported native provider. |
| `openrouter` | Supported native provider. |
| `ollama` | Supported via pi-ai createProvider + lazy OpenAI Completions implementation. |
| `gateway` | Supported alias for `vercel-ai-gateway`. |
| `alibaba` | Unsupported: No native Alibaba provider in the pinned package; Qwen Token Plan is a different service. |
| `amazon-bedrock` | Supported native provider. |
| `anthropic-aws` | Unsupported: No native Anthropic-on-AWS provider; Amazon Bedrock is a different endpoint and account flow. |
| `azure` | Supported native provider. |
| `baseten` | Supported native provider. |
| `cerebras` | Supported native provider. |
| `cohere` | Unsupported: No native Cohere provider in the pinned package. |
| `deepinfra` | Unsupported: No native DeepInfra provider in the pinned package. |
| `fireworks` | Supported native provider. |
| `gmicloud` | Unsupported: No native GMI Cloud provider in the pinned package. |
| `google-vertex` | Supported native provider. |
| `huggingface` | Supported native provider. |
| `minimax` | Supported native provider. |
| `togetherai` | Supported alias for `together`. |
| `zai` | Supported only for the native Z.ai Coding Plan global endpoint. |

## Changed or removed settings

No setting conversion is performed. Old variable names are refused by `--set` for the selected provider.

| Former setting | Replacement / reason |
| --- | --- |
| `anthropic:ANTHROPIC_BASE_URL` | Native Anthropic uses its catalog endpoint, not this override. |
| `openai:OPENAI_BASE_URL` | Native OpenAI uses its catalog endpoint, not this override. |
| `google:GOOGLE_GENERATIVE_AI_API_KEY` | Use GEMINI_API_KEY. |
| `gateway:VERCEL_DEPLOYMENT_ID` | Standalone setup uses AI_GATEWAY_API_KEY; deployment OIDC is not supported. |
| `gateway:VERCEL_ENV` | Standalone setup uses AI_GATEWAY_API_KEY; deployment OIDC is not supported. |
| `gateway:VERCEL_PROJECT_ID` | Standalone setup uses AI_GATEWAY_API_KEY; deployment OIDC is not supported. |
| `gateway:VERCEL_REGION` | Standalone setup uses AI_GATEWAY_API_KEY; deployment OIDC is not supported. |
| `amazon-bedrock:AWS_ENDPOINT_URL` | The native provider selects endpoints from its catalog/region. |
| `azure:AZURE_API_KEY` | Use AZURE_OPENAI_API_KEY. |
| `azure:AZURE_RESOURCE_NAME` | Use AZURE_OPENAI_RESOURCE_NAME or AZURE_OPENAI_BASE_URL. |
| `google-vertex:GOOGLE_VERTEX_LOCATION` | Use GOOGLE_CLOUD_LOCATION. |
| `google-vertex:GOOGLE_VERTEX_PROJECT` | Use GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT. |
| `google-vertex:GOOGLE_VERTEX_API_KEY` | Use GOOGLE_CLOUD_API_KEY, or project/location plus ADC. |
| `huggingface:HUGGINGFACE_API_KEY` | Use HF_TOKEN. |

## Current provider choices

All entries share the package pin above. Aliases retain their ID in agent files and model lookup. Optional settings are listed in `providers.json`.

| ID | Default required settings | Alternatives / notes |
| --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_AUTH_TOKEN`; `ANTHROPIC_OAUTH_TOKEN`; `ANTHROPIC_FEDERATION_RULE_ID` + `ANTHROPIC_ORGANIZATION_ID` + `ANTHROPIC_IDENTITY_TOKEN_FILE`; API key, existing bearer/OAuth token, or workload identity environment settings. Setup does not log in or refresh OAuth tokens. |
| `openai` | `OPENAI_API_KEY` |  |
| `google` | `GEMINI_API_KEY` | Uses GEMINI_API_KEY (not GOOGLE_GENERATIVE_AI_API_KEY). |
| `moonshotai` | `MOONSHOT_API_KEY` |  |
| `xai` | `XAI_API_KEY` |  |
| `deepseek` | `DEEPSEEK_API_KEY` |  |
| `mistral` | `MISTRAL_API_KEY` |  |
| `groq` | `GROQ_API_KEY` |  |
| `openrouter` | `OPENROUTER_API_KEY` |  |
| `ollama` | None | Install/start Ollama and pull a tool-capable model first. Type its exact model id (including tags). Uses the OpenAI-compatible /v1 API, not Ollama's native chat API; no key required locally. Custom models use conservative text-only, non-reasoning metadata, 32768 context and 4096 output tokens; actual server/model limits may be lower. |
| `gateway` | `AI_GATEWAY_API_KEY` |  |
| `amazon-bedrock` | `AWS_BEARER_TOKEN_BEDROCK` | Folder-scoped setup supports a bearer token only. Native profile/access-key/role alternatives are refused because the pinned adapter can consult machine-level credentials. Configure AWS_REGION/AWS_DEFAULT_REGION explicitly if needed. |
| `ant-ling` | `ANT_LING_API_KEY` |  |
| `azure` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_BASE_URL` | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_RESOURCE_NAME`; Set AZURE_OPENAI_API_KEY and AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME. Models may be Azure deployment names. Uses native Responses/Completions catalog APIs; legacy deployment URLs are not supported. |
| `baseten` | `BASETEN_API_KEY` |  |
| `cerebras` | `CEREBRAS_API_KEY` |  |
| `cloudflare-ai-gateway` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_KEY`, `CLOUDFLARE_GATEWAY_ID` |  |
| `cloudflare-workers-ai` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_KEY` |  |
| `fireworks` | `FIREWORKS_API_KEY` |  |
| `github-copilot` | `COPILOT_GITHUB_TOKEN` | Requires an existing COPILOT_GITHUB_TOKEN; enable the desired model in Copilot. Setup does not perform subscription login. |
| `google-vertex` | `GOOGLE_CLOUD_API_KEY` | `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`; `GCLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`; `GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`; `GOOGLE_APPLICATION_CREDENTIALS` + `GCLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`; Google Cloud API key, or project/location plus ADC: place the credential file inside the agent folder and set GOOGLE_APPLICATION_CREDENTIALS to its relative path. No key is needed with ADC. |
| `huggingface` | `HF_TOKEN` |  |
| `kimi-coding` | `KIMI_API_KEY` |  |
| `meta` | `META_API_KEY` |  |
| `minimax` | `MINIMAX_API_KEY` | Global endpoint; minimax-cn is the separate China endpoint. |
| `minimax-cn` | `MINIMAX_CN_API_KEY` |  |
| `moonshotai-cn` | `MOONSHOT_API_KEY` |  |
| `nvidia` | `NVIDIA_API_KEY` |  |
| `opencode` | `OPENCODE_API_KEY` |  |
| `opencode-go` | `OPENCODE_API_KEY` |  |
| `qwen-token-plan` | `QWEN_TOKEN_PLAN_API_KEY` |  |
| `qwen-token-plan-cn` | `QWEN_TOKEN_PLAN_CN_API_KEY` |  |
| `qwen-token-plan-individual` | `QWEN_TOKEN_PLAN_API_KEY` |  |
| `radius` | `RADIUS_API_KEY` |  |
| `together` | `TOGETHER_API_KEY` |  |
| `togetherai` | `TOGETHER_API_KEY` |  |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` |  |
| `xiaomi` | `XIAOMI_API_KEY` |  |
| `xiaomi-token-plan-ams` | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |  |
| `xiaomi-token-plan-cn` | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |  |
| `xiaomi-token-plan-sgp` | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |  |
| `zai` | `ZAI_API_KEY` | Z.ai Coding Plan global endpoint, not the general API billing endpoint. |
| `zai-coding-cn` | `ZAI_CODING_CN_API_KEY` |  |

## Other unsupported native entries

- `openai-codex`: Requires OAuth credential storage/login; fresh setup supports environment/ambient auth only.
- `typesafe`: No tool-calling chat catalog.

Unknown providers are refused rather than treated as package names. There is no dynamic package installation or arbitrary provider module loading.
