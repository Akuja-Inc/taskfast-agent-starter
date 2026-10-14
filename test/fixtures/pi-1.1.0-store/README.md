# Agent store written by Pi 1.1.0

`state.sqlite` is a real agent store produced by `@earendil-works/pi-durable` 1.1.0
with the process killed while a write tool's CLI dispatch was blocked. It holds:

- a policy with the staging identity `33333333-3333-4333-8333-333333333333`, one
  note, a `done` post_task action and a `reserved` one, and that day's spend of 6;
- a completed `pi.tool` task (the done post) and a live version 1 `pi.tool` task
  interrupted mid-dispatch (the reserved post), which pi-durable 1.2.0 must migrate
  to the version 2 tagged-union shape on open without re-dispatching it.

`make-store.mjs` regenerates it; run it only on a checkout whose Pi packages
resolve to 1.1.0, as its header explains. The `state.sqlite.owner` lock database
is not fixture content: the opener recreates it.

Tests copy this store to a temporary directory and reopen it under the pinned
version, so the upgrade is checked against real 1.1.0 bytes, not a lookalike.
