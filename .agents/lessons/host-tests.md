# Host tests with a scripted model

- A host test whose scripted model waits on a gate hangs on shutdown, instead of failing, when an assertion throws before the gate opens; release the gate in a `finally`. (PR #133)
