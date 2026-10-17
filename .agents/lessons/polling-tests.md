# Host polling tests

- The host sleeps through `node:timers/promises`; control the promise-timer boundary in polling tests and assert abort on reopen rather than advancing Vitest fake timers. (issue #100)
