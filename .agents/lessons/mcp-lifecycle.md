# MCP lifecycle

- Pi-mcp 1.2.0 request timeouts do not bound notification handshakes or cancel HTTP response I/O; use an overall opening deadline, close the sequential server on call timeout/abort, and retain stdio process-group ownership after the parent exits. Test actual sockets and descendants, not only rejected promises. (PR #74)
