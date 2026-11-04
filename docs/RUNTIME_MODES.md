# Runtime modes

The runtime exposes two explicit modes:

- **Thinking** is the default and is read-only. Approval responses are rejected before reaching TrueForge.
- **Tool** allows TrueForge approval events to continue through the verified `user.tool_approval` request path. TrueForge remains the authority for tool execution and approval state.

Mode changes are emitted as `mode.changed` events so the Webview can display the active policy. Selecting Tool mode does not auto-approve any pending tool call.

