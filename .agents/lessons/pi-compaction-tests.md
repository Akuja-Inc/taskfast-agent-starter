# Pi compaction tests

- A value returned by `tx.doc()` is a transaction-bound overlay, not a snapshot; inspect it inside the commit or return copied plain data, because reading it after the commit throws `Cannot use a settled overlay`. (Issue #40)
- Pi's `waitForIdle()` excludes background compaction; wait for the persisted `pi.compaction` entry before asserting its result or closing the store. (Issue #40)
