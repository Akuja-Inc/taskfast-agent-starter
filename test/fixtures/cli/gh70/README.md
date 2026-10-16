# Captured bond output (gh#70)

Real stdout of the `taskfast` 0.19.7 binary (the version this kit pins), run with
`--env local` against `stand-in-server.py` in this folder. The server answers the shapes
`test/fixtures/openapi.yaml` documents, so nothing here touches a marketplace account, a
chain or funds.

Every `<name>.json` is the CLI's own envelope, unchanged. Every `<name>.requests.log` is
what the stand-in server received during that command, which is how a capture shows
whether the command touched the chain.

| Capture | Command | Exit | What it shows |
|---|---|---|---|
| `bond-dry-run` | `bond post <task> --dry-run` | 0 | The quote read: `data.amount` (2500000 bond base units), `data.token`, `data.task_bond`, `data.action=would_post_bond`. The request log holds one quote `GET` and one `GET /config/network`, so the dry run makes no RPC call and no transaction. |
| `claim-bond-pending` | `task claim <task>` | 7 | A 409 `bond_pending` prints `error.code = "validation"`; the server's code survives only in the message. |
| `bond-report-posting-disabled` | `bond post <task>` | 7 | The same `validation` code after the post already confirmed: the request log shows `eth_sendRawTransaction` and `eth_getTransactionReceipt` before the refused report. |
| `bond-preflight-balance` | `bond post <task>` | 2 | A wallet below the bond is refused as `usage` before any transaction (the request log stops after `balanceOf`). |
| `cast-decimals` | `cast call <token> "decimals()(uint8)"` | 0 | `data.decoded[0]` is the token's decimals, read with no wallet and no funds. |

The signed transaction in `bond-report-posting-disabled.requests.log` is redacted; the
rest of the log is byte-for-byte what the server received.

## Re-capturing

The stand-in server needs only Python 3:

```bash
python3 test/fixtures/cli/gh70/stand-in-server.py --port 4123 &
```

Scenarios come from environment variables, so one capture is one server start. For the
refused report, `REPORT_STATUS=409 REPORT_CODE=posting_disabled`; for the short wallet,
`BALANCE_LOW=1`; for the claim, `CLAIM_STATUS=409 CLAIM_CODE=bond_pending`.

`bond post` decrypts the keystore even for `--dry-run`, so the captures need a throwaway
keystore and its password file. Never use a real one. The captures above were made from a
local-only account with no funds:

```bash
python3 - <<'PY'
from eth_account import Account
import json
account = Account.from_key("0x" + "11" * 32)
open("/tmp/gh70/wallet.json", "w").write(json.dumps(Account.encrypt(account.key, "testpassword")))
PY
printf 'testpassword' > /tmp/gh70/pw
```

Then, from the repository root:

```bash
taskfast --env local --allow-custom-endpoints --api-base=http://127.0.0.1:4123 \
  --config=/tmp/gh70/absent.json --no-trace \
  bond post 4b7e9c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b --dry-run \
  --keystore=/tmp/gh70/wallet.json --wallet-password-file=/tmp/gh70/pw
```

`--allow-custom-endpoints` is what lets the CLI talk to a loopback stand-in instead of a
deployment. Keep the server's `rpc_url` on the same host as the API base, or the CLI
refuses to route RPC traffic off-host.

`src/core/money.test.ts` covers the parser's own cases; `test/cli-captures.test.ts` reads
`bond-dry-run.json` and `cast-decimals.json`, so a change in either shape fails there
first. Never edit a capture to make a test pass: re-capture it.
