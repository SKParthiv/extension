# TrueForge Context Agent

VS Code coding-agent extension whose agent loop runs in TrueForge. The extension starts a loopback MCP server with bounded workspace discovery, file reads, search, context retrieval, staged proposals, approved hunk application and approved command execution.

## Reproducible local setup

Prerequisites: Node.js 22+, VS Code 1.90+, and a locally configured TrueForge server. The tested SDK is `@truefoundry/trueforge-sdk@0.183.0`; the tested MCP SDK is `@modelcontextprotocol/sdk@1.32.2`.

```powershell
npm ci
$env:NETWORK_POLICY_ENABLED = "true"
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["localhost","127.0.0.1"]'
npx --yes @truefoundry/trueforge@0.183.0
```

Open a workspace in VS Code and set `trueforge.agentName` to `trueforge-extension-agent`. The extension binds its MCP endpoint to `127.0.0.1:8765` by default, stores its bearer token in VS Code SecretStorage, and does not print the token. If port 8765 is occupied, set `trueforge.mcpPort` before activation; it will not silently change ports.

After activation, run `TrueForge: Copy MCP Connector Credentials` from the command palette. This copies the loopback URL and bearer token as a one-time user-directed setup action; the token remains in VS Code SecretStorage and is never logged. Then register the connector and saved agent with the verified SDK:

```powershell
$env:TRUEFORGE_CONNECTOR_URL = "http://127.0.0.1:8765/mcp"
$env:TRUEFORGE_MCP_TOKEN = "<token from VS Code SecretStorage setup flow>"
$env:TRUEFORGE_MODEL = "<model FQN already listed by TrueForge>"
node scripts/bootstrap-trueforge.mjs
```

The script uses the documented `settings.mcpServers.createOrUpdate`, `models.list`, `agents.list`, `agents.create` and `agents.update` SDK methods, followed by post-creation assertions validating all 8 tools, approval triggers for `apply_hunk` and `run_command`, iteration limit, and attached connector. It fails if the model is missing and is idempotent for both connector and agent resources. No provider client or cloud fallback is embedded in the extension.

Proposals use stable diff hunks, allowing per-hunk review and approval directly in the Webview with native VS Code diff review. Applied edits are registered in the SafeUndo service and undoable on demand.

Run the local checks with:

```powershell
npm test
npx tsc --noEmit
npm run build
```

The MCP transport is intentionally stateless: every HTTP request receives a fresh SDK server and `StreamableHTTPServerTransport`, while workspace services and staged proposals remain extension-owned. This avoids reusing a transport across independent requests and is covered by repeated initialization, tool discovery and invocation tests. TrueForge, the configured model and the connector remain separate resources; the saved agent attaches the connector and each application session maps to its own TrueForge session.

This repository is original work from scratch and does not fork an upstream editor project.

