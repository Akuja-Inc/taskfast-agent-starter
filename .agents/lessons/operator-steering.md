# Operator steering

- Pi 1.1.0 returns `settled` when aborting an already aborted submission. During promotion recovery, inspect the original record for an unplaced `unanswered` input with reason `aborted`, tied to a durable steer intent, before admitting its deterministic replacement. `inspect()` omits settled records. (Issue #39)
- Promoting a legacy queued input gives its replacement a newer Pi submission ID. Save the original queue order before withdrawal or the console will show the correction as newer than messages admitted after it. (Issue #39)
