# Local MCP server

Verified with `@modelcontextprotocol/sdk@1.32.2`.

- `McpServer` is the high-level server API.
- `StreamableHTTPServerTransport` is the Node.js HTTP transport.
- The server binds to `127.0.0.1` on an ephemeral port.
- Every `/mcp` request requires the random per-launch bearer token.
- The server owns two compact tools: `echo` and `echo_write`.
- `echo` is read-only.
- `echo_write` is approval-required and rejects direct execution. A future TrueForge approval callback must explicitly authorize it before any mutation-capable implementation is added.
- The server is stopped by calling `stop`; extension deactivation must call that lifecycle method.

The outbound guard and TrueForge MCP registration are intentionally deferred until their installed configuration APIs are verified.
