# Cloudflare spikes for #144

These are the two spikes that #144 asks for before any Durable Object (DO) host code. The code is in `spikes/cloudflare/`, a throwaway package with its own lockfile. It sits outside the kit's build, typecheck and tests. The Pi pins stay exactly 1.2.0.

Result: both spikes pass. The CLI pick is **option A, the pinned CLI image in a Container**.

## Pi spike

Question: do `@earendil-works/pi-ai` and `@earendil-works/pi-durable` load under workerd at the 1.2.0 pin, and does Pi storage in a SQLite-backed DO survive a restart?

`spikes/cloudflare/src/worker.js` is a Worker with one DO class. The DO opens Pi storage with `openDurableObjectSqliteStorage(ctx.storage)`, then opens the runtime the same way `src/core/agent.ts` does. It runs one turn with the faux provider under `nodejs_compat`. Before each turn it reserves an action key in a session doc, which stands in for the policy ledger.

Repro, from `spikes/cloudflare/` after `pnpm install --ignore-workspace`:

```bash
node restart-proof.mjs
```

The script starts `wrangler dev` with `--persist-to` on a temporary folder. It runs a turn, then a second turn with the same action key, and kills workerd with SIGKILL. It restarts workerd on the same folder and reads back. Expected last line: `ok: Pi storage and the ledger survived a workerd restart`.

What it showed (wrangler 4.152.0, workerd 1.20261019.1):

- Both packages bundle and run under workerd with `nodejs_compat`. The spike Worker is 996 KiB (185 KiB gzipped).
- The 12 exports of `@earendil-works/pi-ai/providers/all` and the `@earendil-works/pi-ai` root also bundle and load (4.4 MiB, 594 KiB gzipped). The kit's `providers.json` names 43 providers, and this spike did not load each one through `src/core/model.ts`. No real model was called.
- One turn ran: one model call, and the transcript holds a user and an assistant message.
- The second reservation of the same key was refused. After the kill and restart, the transcript (4 messages) and the reserved key were both there.
- Opening Pi on an existing DO took 6 to 8 ms locally.

What it did not show:

- No deployed DO and no eviction under Cloudflare's own scheduler. `wrangler dev` runs the same workerd and SQLite storage locally.
- `src/core/agent.ts` does not load in a DO as it is. These core modules import Node APIs that workerd lacks or stubs: `cli.ts` (child processes), `storage.ts` (`node:sqlite` and the owner lock), `folder.ts`, `jsonl.ts`, `mcp-config.ts`, `media.ts`, `model.ts`, `policy.ts`, `pump.ts` and `skills.ts` (files). PR3 must put storage, the CLI runner and the folder reads behind seams.

## CLI spike

Question: how does the DO reach the marketplace? Option A runs the pinned `taskfast` CLI as an image in a Cloudflare Container. Option B replaces `runCli` with `fetch` and signs in JavaScript. The issue says to pick A unless B passes every check.

### Option A

`spikes/cloudflare/cli/Dockerfile` downloads the `taskfast-cli-v0.21.0` Linux release and checks its SHA-256 (`1df1aa7e…98899`). It holds no state and no secrets. It runs as a non-root user. The image is 96 MB.

Envelope parity, from `spikes/cloudflare/cli/` after `docker build -t taskfast-cli:0.21.0 .`:

```bash
node parity.mjs
```

The script runs 9 captured commands, plus one against a closed port, from `test/fixtures/cli/gh70` and `gh71` against their stand-in servers. Each command runs once with the host `taskfast` 0.21.0 and once in the image. The image runs with `--read-only` and the work folder mounted read-only. The two bond commands decrypt a throwaway keystore made the way `gh70/README.md` says. Expected last line: `ok: the image prints the same envelope and exit code as the host binary for every captured command`.

| Capture | Exit | Host ms | Image ms | Matches the capture |
|---|---|---|---|---|
| `gh71/artifact-list` | 0 | 11 | 250 | yes |
| `gh71/artifact-delete` | 0 | 10 | 233 | yes |
| `gh71/submit-artifacts` | 0 | 95 | 321 | yes |
| `gh71/submit-second-upload-refused` | 7 | 55 | 292 | yes |
| `gh71/submit-missing-file` | 2 | 7 | 240 | yes |
| `gh70/cast-decimals` | 0 | 53 | 276 | yes |
| `gh70/claim-bond-pending` | 7 | 11 | 245 | yes |
| `gh70/bond-dry-run` | 0 | 462 | 683 | yes |
| `gh70/bond-preflight-balance` | 2 | 522 | 727 | yes |
| unreachable server (`task claim`) | 6 | 10 | 235 | not captured |

The comparison ignores `environment`, `dry_run` and `security_warnings`, which name the stand-in's address. It also masks the stand-in's port and the random salt that `bond post` draws on every call. Exit codes 2 and 7 still come out unchanged, so `REFUSED` in `cli.ts` keeps its meaning. With no server, both print error code `network` with exit 6. `network` is not in `REFUSED`, so a write that cannot reach the server stays `uncertain`.

Staging, with the `staging-worker` folder and no host running on it:

```bash
node staging.mjs ../../../agents/staging-worker
```

The script mounts only the agent's `.taskfast/` folder, read-only, and passes `--env staging --config=.taskfast/config.json --no-trace`. It prints status, timings and field names, never values.

| Command | Result | Host ms | Image ms |
|---|---|---|---|
| `ping` | ok, exit 0 | 180 | 526 |
| `me` | ok, exit 0, same fields as the host | 265 | 617 |
| `agent update-me --description=<current>` | ok, exit 0 | not run | 567 |

The write sets the agent's description to the value it already had. It is a real staging write that changes nothing.

Latency: a fresh `docker run` adds about 230 to 350 ms per command on this machine. That is a local stand-in for a Container start. It is not a Cloudflare Container cold-start number, which needs a deployed Container (PR4).

What it did not show:

- No signed write on staging. `post`, `settle`, `escrow sign` and `bond post` spend test funds or need a task in the right state. A keystore decrypt and a signed calldata build did run read-only in the image (`gh70/bond-dry-run`).
- No Cloudflare Container. The DO-to-Container path, how secrets reach a call, and the real cold start are PR4 work.

### Option B

The staging keystores use scrypt with N=8192, r=8, p=1 and AES-128-CTR. One scrypt at those settings takes 13.9 ms with native `node:crypto` and needs 8 MiB of memory. That fits the Worker limits with room to spare, even if a JavaScript scrypt runs several times slower.

The parity check fails. Nothing in the CLI's output shows the EIP-712 typed data or signature for `post`, `settle` or `escrow sign`. Only `bond post` shows its calldata. Proving that B's payloads match the CLI's would mean writing the signing code first and then comparing raw requests against a stand-in. The issue says to pick A unless B passes every check, so the spike stops here.

## Pick

Option A. It keeps the CLI's envelope, the exit codes behind `REFUSED`, the captured fixtures and the parity tests. B would rewrite the money path and could not show payload parity.

Open questions for PR4: how the DO calls the Container, so that only the DO can reach it; how the config, keystore and password file reach one call without landing on Container disk; and the cold-start time of a deployed Container on a write. This spike mounted the whole `.taskfast/` folder for every command. PR4 must pass the keystore and password file only to `post`, `settle`, `escrow sign` and `bond post`, as #144 requires.
