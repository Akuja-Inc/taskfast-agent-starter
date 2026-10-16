# Agent capabilities

Open the local console and choose **Capabilities**. The agent selector still chooses one agent, and the page names that agent's folder. Skills supply guidance. MCP servers supply explicitly approved external read tools. Neither can grant new TaskFast permissions or bypass the permanent action ledger.

## Skills

Use **Add TaskFast skill** to stage the embedded bundle from the installed CLI. This export runs in a temporary folder without your account configuration. It does not install software, initialize an account or update a running agent. Review the CLI version, hashes and file contents before applying.

Use **Import skill folder** to select a folder from your device. It must contain a valid `SKILL.md`. Files stay under this agent's `.agents/skills/` tree. Invalid paths, private files, symlinks and oversized imports are refused. Previews are plain text. Scripts do not run, and imported instructions cannot add a shell or general filesystem tool.

Inspect a skill to see its files and provenance, or stage enable, disable, replacement or removal. Replacement is explicit. Disable keeps the installed files but removes the skill from future discovery after apply. It cannot remove instructions the model has already read from its conversation history. Removal affects only this agent's installed copy.

## MCP servers

Add a server through **Connection**, **Test and review tools**, and **Review and save**. Remote servers use Streamable HTTP over HTTPS, with HTTP allowed only for loopback development. Local servers use an installed absolute executable path, separate arguments and an agent-relative working directory. There is no shell or package installation.

Local programs run with the host user's privileges. An agent-relative directory is not a sandbox. Use only trusted programs and services. The host never supplies model settings, TaskFast credentials or wallet unlock material to a local MCP child. Explicit MCP bindings come from this agent's private `.mcp.env`, separate from its model-provider `.env`.

Before testing, inspect the executable, arguments, resolved working directory and credential binding names, or the remote destination. Consent authorizes a real connection and tool discovery, not tool execution. Testing never invokes a sample tool, modifies the running agent's registry or approves a tool automatically. A successful test means **Test passed; not active**.

Review tools individually. Server annotations are claims, not a safety review. Known writes remain unavailable. You must explicitly approve each read and its exact definition. A changed connection, credential or tool definition needs another test and review. Reconnects and tool-list notifications never silently expand access.

Approved reads can disclose task content and incur service charges. TaskFast spending limits do not cover those charges. The model has no automatic retry permission after a failed external read. MCP tools never become an alternate route to TaskFast, signing, a shell or arbitrary filesystem access.

New credential values use masked fields and are never returned in ordinary views. Saved values show **Configured**. They are not stored in browser storage. Private pending changes live in this agent's ignored `.capabilities/` directory. Discard removes staged credential values. Do not print, share or commit `.mcp.env` or `.capabilities/` contents.

## Review and apply

Skill and server edits share one pending batch for the selected agent. Review **Active now → After apply**, including credential binding names and explicit tool access. Staging, connection tests and runtime activation are separate operations.

| State | Meaning | Available action |
| --- | --- | --- |
| Pending | The current registry remains active. | Edit, review or discard. |
| Waiting for idle | The host admits events durably but holds new scheduling while current work finishes. | Cancel the wait, keeping pending changes. |
| Applying | The host publishes the reviewed configuration and reopens only this agent. | Wait. Publication cannot be canceled. |
| Applied | The reopened agent uses the new configuration. | Inspect the active revision. |
| Failed | The view reports the actual active state after recovery. | Review the error and retry after fixing it. |

Applying never aborts an in-flight marketplace write. The host preserves the owner's latest Pause and spending-freeze choices, admitted events, conversation, permanent action keys and daily spending. Briefing saves and capability applies share a lifecycle lock. A cleanup failure blocks reopening rather than risking two owners.

Every mutation carries a configuration revision. A conflicting browser or manual edit requires refreshed review. Apply requests also carry an identity, so retrying a lost response does not authorize another reopen. Drafts, tests and approvals remain tied to their originating agent. Switching agents cannot retarget them, and unsaved secret entry is cleared.

Configuration belongs to the agent folder, not one environment. Other environments read it when they next open that folder. Stop the agent before moving or archiving it, preserve its whole ledger and private capability files, and never run original and restored copies together. A copied folder does not install external executables or authorize access to remote services.

## Local validation

Run the bounded tests first, then the repository gate and TUI smoke test:

```bash
pnpm vitest run test/capabilities.test.ts test/console-capabilities-host.test.ts src/core/agent-quiesce.test.ts
pnpm check
pnpm tui:test
```

The tests use temporary agent folders, real SQLite stores, scripted model output and local MCP fixtures. They do not validate a live marketplace, model provider or third-party MCP service.

`browser-host.mjs` serves the real console with temporary agents, real stores and a faux model. It never reads a real agent folder. After `pnpm build`, run `python3 docs/capabilities/capture.py after` to capture both themes at desktop and phone widths. The baseline captures use the same fixture with the built parent revision supplied as the last argument.
