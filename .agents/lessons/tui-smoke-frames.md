# TUI smoke-test frames

- `src/tui/smoke.test.tsx` matches only the visible frame, and the timeline scrolls to the selected reply, so lengthening a reply in `test/fixtures/tui-host.mjs` hides later waits ("never drew it"); size the test's `draw()` terminal to fit, or wait on sidebar text. (issue #59)
