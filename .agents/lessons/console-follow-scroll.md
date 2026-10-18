# Console timeline follow scrolling

- Any programmatic scroll, even `scrollBy(0, 0)`, cancels an in-flight smooth `scrollIntoView`; a render that follows new content must also hold the reading anchor on the next render. (PR #124)
- `body.away` updates through `requestAnimationFrame`, so a push landing in the same frame as the reader's scroll-away reads a stale "at bottom"; measure at-bottom from pre-rebuild geometry in `render()`. (PR #124)
