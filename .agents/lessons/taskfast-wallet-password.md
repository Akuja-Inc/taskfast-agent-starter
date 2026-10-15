# TaskFast wallet password

- `taskfast init` and the signing commands prefer `TASKFAST_WALLET_PASSWORD`, and `init` also prefers its own interactive "Generate new wallet" password, over `--wallet-password-file`, while the host passes only the file. Pass `--generate-wallet` with the file and refuse a set variable, or the wallet is encrypted with a password the host never sees. (taskfast-cli 0.19.7 `wallet_args.rs`, `init.rs`)
