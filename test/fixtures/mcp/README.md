# Local MCP fixture server

`server.mjs` is a hand-written MCP server for tests, not a capture of a real one. Run with Node, it speaks newline-delimited JSON-RPC over stdio. Its `handle` export serves the same tools over Streamable HTTP from `test/mcp-fixture.ts`. It answers `initialize`, `ping`, `tools/list` and `tools/call`.

Its tools cover the cases the tests need: `search` (a read), `env` (prints its environment), `slow`, `fail` (a tool error), `big` (a large answer), `exit` (ends the process), `delete` (marked destructive), `sample` (asks the client for a model completion over stdio, which the kit refuses) and `image` (a tiny PNG as an image block and as an embedded resource, which the kit saves as media). `FIXTURE_MODE=changed` changes `search`'s description, `paged` splits `tools/list` into two pages, and `crash` exits on `initialize`. `FIXTURE_PIDFILE` makes it start a grandchild and write its pid there, so a test can check that closing stops the whole process tree.

No test contacts a real MCP service.
