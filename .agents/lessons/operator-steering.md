# Operator steering

- A promotion can retain its intent after admitting a replacement. Withdraw both queued submission IDs and clear the buffer/intent in one Pi transaction; an aborted original alone never proves the replacement was not placed. Keep request tombstones even for buffered-only withdrawals, so send retries cannot resurrect them. (Issue #63)

- Pi 1.1.0 returns `settled` when aborting an already aborted submission. During promotion recovery, inspect the original record for an unplaced `unanswered` input with reason `aborted`, tied to a durable steer intent, before admitting its deterministic replacement. `inspect()` omits settled records. (Issue #39)
- Promoting a legacy queued input gives its replacement a newer Pi submission ID. Save the original queue order before withdrawal or the console will show the correction as newer than messages admitted after it. (Issue #39)
