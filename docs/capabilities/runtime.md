# Capability management runtime

This is the backend prerequisite for #64's web editor, built on the MCP read-tool integration in #74. It adds no browser controls by itself. Existing agents with no capability files keep their tools, prompt and startup behavior.

`src/capabilities.ts` owns one agent folder's validated pending batch. Hosts create a `CapabilityManager`, read its redacted `view()`, and send checked operations through `command(action, body)`. `src/capability-types.ts` defines the browser-safe contract. Every mutation carries the revision returned by its view. Changing the actual files or the staged draft invalidates that revision, requiring refreshed review.

The manager stages skill imports and CLI bundle exports, skill enable/disable/removal, server configuration and credential changes. It tests only owner-consented MCP discovery, never calls an example tool, and requires explicit read approval of each enabled tool's exact fingerprint. Known writes cannot be approved. Disabled servers start no process or connection. Disabled skills stay installed but do not appear in future discovery; disabling cannot erase previously loaded instructions from conversation history.

Credentials stay in private, agent-owned staging and publish to `.mcp.env` with mode `0600`. Views contain binding names and configured status, never credential values. Secrets in arguments or URLs are refused. The host must not log request bodies or private staging. `.capabilities/` and `.mcp.env` are ignored by Git. Keep both with a stopped agent when moving or archiving its folder, along with the existing permanent ledger.

## Activation contract

The manager calls its host-owned `activate({publish, rollback, signal, afterCommit})` hook asynchronously. Apply state starts at Waiting, so a long run does not block the request. Canceling the wait leaves the pending batch intact. Calling `publish()` enters Applying, after which cancellation is unavailable. Hosts must finish the active work before calling it and must reopen only the affected agent with `startHeld: true`. That initial hold covers recovered events as well as new polling. Verify the reviewed image again after connecting the replacement. Register its release through `afterCommit`, not inside the opening hook, so no new work can dispatch before the durable journal commit. The optional failure callback closes a dormant replacement if committing fails and reports whether rollback restored the previous files. A failure after commit never rolls configuration back, because the new registry may have dispatched work.

`MarketplaceAgent.quiesce(signal)` holds new host scheduling without changing the owner's durable Pause or spending-freeze choices. It waits for already-submitted work to finish and returns an idempotent release function. Event admission continues durably. Canceling this wait releases the hold without aborting the model or signaling an in-flight marketplace write. A host must release the hold in `finally`, including after a failed publication.

Publication uses a private, fsynced write-ahead journal containing the before and after file images. `recoverCapabilities(agentDir)` handles interrupted publication before an initial runtime open. It rolls back a partial publication only when current files match the recorded before or after image. An unrelated manual edit fails closed and preserves the journal. Do not invoke crash recovery against an intentional reopen while the publication is still in progress: successful registry opening is what lets the manager commit that journal. A failed reopen must restore the previous files, preserve the pending draft and report the actual running or stopped state.

The manager records apply request identities so a lost acknowledgement does not authorize a second activation. Configurations remain folder-scoped, not environment-specific. The same folder's other environments use the new files when they next open it.

## Local proof

```bash
pnpm vitest run test/capabilities.test.ts test/capability-activation.test.ts src/core/agent-quiesce.test.ts
pnpm check
```

The integration test publishes a staged skill and reopens a real SQLite store, checking that a completed marketplace action and the owner's Pause choice survive unchanged. Other tests exercise local stdio and Streamable HTTP fixtures, credential redaction, explicit approval, stale revisions, import failures, cancellation and journal recovery. No live marketplace, model provider or third-party MCP service is exercised.
