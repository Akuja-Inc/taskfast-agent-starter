# OpenTUI span colours

- `@opentui/solid@0.6.3` sets only `href` and `style` on text nodes (`span`, `b`, `i`, `a`) and silently drops `fg`/`bg` props, so pass colours as `style={{ fg, bg }}`; `smoke.test.tsx` compares characters only, so check colours with `tmux capture-pane -e`. (issue #59)
