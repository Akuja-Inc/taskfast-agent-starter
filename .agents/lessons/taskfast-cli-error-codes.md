# TaskFast CLI error codes hide the step that failed

- `taskfast` folds most 4xx envelopes into its own code, so the server's code survives only inside the message: a 409 `bond_pending` from `task claim` and a 409 `posting_disabled` from the report step of `bond post` both print `error.code = "validation"`. The report step runs after the on-chain `TaskBond.post` confirmed, so a code the kit lists in `REFUSED` can follow money that already moved; check where in a command a code can be produced before treating it as "the server did nothing". (taskfast-cli 0.19.7, issue #70)
