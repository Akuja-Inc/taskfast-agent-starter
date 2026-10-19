# Generated-agent example and recovery

This example joins setup, the captured CLI skill, approved MCP reads and the permanent ledger in one executable test. The [console guide](README.md) covers imports, consent, approval and Apply when idle.

## Run the example

Use Node 24 and the repository's pinned pnpm, from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm vitest run test/generated-capabilities.test.ts
```

Expect two passing cases, `stdio` and `http`. The test creates a temporary kit, runs fully flagged setup with `--env staging`, `--no-init` and `--taskfast-skill`, and removes only its own temporary files after closing their owners. It never opens `agents/` in your checkout. No account, wallet, provider key or installed `taskfast` binary is required for this offline test.

Setup's injected CLI exporter copies the unchanged `taskfast` 0.21.0 capture, including both export destinations, rather than inventing a skill. Setup publishes only `.agents` and records provenance. The test checks all seven installed files against those hashes. [Capture provenance](../../test/fixtures/cli/README.md) explains the original export and how to recapture it. This test does not revalidate an installed CLI binary on every run.

Setup writes a normal `ollama:fixture` agent. The test substitutes Pi's scripted model in memory, leaving the generated file unchanged. Marketplace commands return scripted results through the existing command seam. MCP uses real local stdio processes and loopback Streamable HTTP sockets, with synthetic credentials and exact fixture-tool fingerprints. These fingerprints approve only the test fixture, not a third-party service.

| Step | Asserted outcome |
| --- | --- |
| Generate | No prompts, account initialization or package installation; CLI version and all file hashes recorded. |
| Discover and read | The durable conversation reads `SKILL.md`, `reference/WORKER.md`, the matching `me` tool and an approved MCP search. |
| Refuse | A skill traversal cannot read `.mcp.env`; an unapproved MCP delete is unavailable. Credentials stay out of transcript and diagnostics. |
| Reserve and dispatch | One post reaches the scripted command, returns uncertain and retains its 3 USD fee in the ledger. |
| Check ownership | A second store owner is refused while the first agent is open. |
| Compact | Pi actually compacts the conversation while Pause and spending freeze are set. |
| Admit and stop | An event is durably admitted while paused; the agent closes before its folder moves. |
| Relocate | The whole stopped folder moves by rename, without copying or resetting state. Skill provenance and MCP configuration remain byte-identical; private bindings still resolve. |
| Reopen | Notes, spending, uncertain action, Pause and freeze survive. The local server's relative working directory and script still work. |
| Recover | After unfreezing and resuming, the admitted event reloads the role reference and uses MCP. A fresh tool-call ID cannot repeat the uncertain post. Redelivering the event starts no new model work. |

## Equip your own agent

For a fresh agent, use setup's `--taskfast-skill` flag with the other answers described in the [setup guide](../../README.md#answering-with-flags).

For an existing agent, choose its folder in the console, then open **Capabilities**. Add the TaskFast skill or import a validated skill folder. For MCP, configure a trusted installed executable or remote service, enter this agent's private bindings, consent to discovery and approve individual reads. Review the shared pending batch and choose **Apply when idle**. A connection test neither calls tools nor activates access.

The active skill catalog is rebuilt for each turn, including after compaction. The model can reload the same installed reference. Disabling a skill prevents future loads but does not erase instructions already in stored history.

### CLI workflow boundary

The captured bundle was written for clients with a CLI. Loading it does not grant command execution. The current mapping lives in `SKILL_COMMANDS` and `UNSUPPORTED_COMMANDS` in `src/core/skills.ts`; `src/core/skills.test.ts` checks the actual bundle against those entries.

| Bundle workflow | Kit boundary |
| --- | --- |
| Bond then claim | Native `bond_post` is available. An uncertain bond remains spent and cannot repeat. This example does not validate signing or a live bond. |
| Deliver files | `task_submit` and `task_remedy` accept up to five supported text files or image/video handles issued by approved MCP tools. Video capture is limited to 50 MiB per file. They own uploads and cleanup; the model supplies no filesystem path. |
| PDF, archive, or an image or video no approved tool produces | Unavailable. The agent must choose work it can complete, or note a missing capability on work it already holds. |
| Retry guidance or stateless restart | Never permission to repeat a successful or uncertain write, including escrow signing. Never discard the ledger. |
| External MCP writes, shell, arbitrary file access or child conversations | Not granted by a skill, server hint or read-tool fingerprint. |

## Move or recover an existing agent

1. Stop, archive and restore the whole folder as the [README](../../README.md#one-folder-is-one-agent) describes. Do not delete a lock file to force ownership.
2. Install the kit, its pinned dependencies, Node and the required TaskFast CLI on the destination. Local MCP executable paths are external prerequisites; remote endpoints and access must still exist. A relative MCP working directory moves with the folder, but its executable is not installed by moving it.
3. Start with the account's existing environment selection. Do not reinitialize credentials, reset state or change an environment association to make startup pass. The host selects the saved explicit environment, not the folder's name.
4. Inspect startup and the actual active capability view before resuming work. Missing credentials, changed approved definitions or an unreachable configured server fail that folder closed. Fix the prerequisite, retest/review a changed contract and retry that folder. Other agents can remain running.

An interrupted capability publication is different from an uncertain marketplace action. The host recovers the publication journal on initial startup, preserving its pending draft and rejecting unrelated file edits. Let the host establish the actual active revision before retrying Apply. An uncertain marketplace action remains uncertain permanently; inspect server state with reads instead of repeating it. See the [publication contract](runtime.md#activation-contract).

## Limits

These tests establish local integration, not live marketplace, model-provider, third-party MCP, signing or funding readiness. They do not prove a model will choose correct tools without scripting, or that a trusted MCP server honors its read-only description. Live validation needs separate explicit permission.
