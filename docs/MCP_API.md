# Local MCP server

Verified with `@modelcontextprotocol/sdk@1.32.2`.

- `McpServer` is the high-level server API.
- `StreamableHTTPServerTransport` is the Node.js HTTP transport.
- The server binds to `127.0.0.1` on an ephemeral port.
- Every `/mcp` request requires the random per-launch bearer token.
- The server owns two compact tools: `echo` and `echo_write`.
- `echo_write` is explicitly marked approval-gated in its description and performs no side effect itself. TrueForge approval policy must be configured before treating it as a mutating tool.
- The server is stopped by calling `stop`; extension deactivation must call that lifecycle method.

The outbound guard and TrueForge MCP registration are intentionally deferred until their installed configuration APIs are verified.

