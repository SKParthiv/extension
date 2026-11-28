# NotTheLeast

**NotTheLeast** is a VS Code AI coding assistant powered by TrueForge. It provides a multi-view coding-agent interface with real-time request lifecycle visibility, inline editing with native diff review, per-hunk approval, safe undo, and TrueForge-powered session orchestration.

## Features

- **Multi-panel UI**: Five independent VS Code views — Chat, Agent Activity, Tool Execution, Diagnostics, and Context Assembly.
  - **TrueForge agent**: One user request drives a TrueForge agent through its tool loop.
  - **Live request lifecycle**: Real-time stage tracking, elapsed time, inactivity warnings.
  - **Thinking & Tool modes**: Read-only Thinking mode vs. approval-gated Tool mode using the same agent.
  - **Inline editing**: Select code, enter an instruction, review the diff, approve individual hunks.
  - **Native diff review**: VS Code diff editor with per-hunk accept/reject.
  - **Safe undo**: All approved edits can be undone within the session.
  - **Context Assembly**: Deterministic selection of context blocks and retrieved evidence under a token budget.
  - **Workspace tools**: 8 MCP tools including list, read, search, symbols, retrieve, propose changes, apply hunk, and run command.
  - **Diagnostics & telemetry**: Connection state, token usage, request timing, GPU metrics, structured logs.
  - **VS Code native**: Uses native editor, diff, Webview view, and SecretStorage APIs.

## Prerequisites

- Node.js 22+
- VS Code 1.90+
- A locally configured TrueForge server


## Installation

1. Clone and install:
   ```powershell
   git clone https://github.com/SKParthiv/extension.git
   cd extension
   npm ci
   ```

2. Open in VS Code and press F5 to launch the Extension Development Host.

## TrueForge Setup

1. Start the TrueForge server:
   ```powershell
   $env:NETWORK_POLICY_ENABLED = "true"
   $env:OUTBOUND_URL_ALLOWED_HOSTS = '["localhost","127.0.0.1"]'
   npx --yes @truefoundry/trueforge@0.185.0
   ```

2. Set `trueforge.agentName` in VS Code settings to `trueforge-extension-agent`.

3. Run `NotTheLeast: Copy MCP Connector Credentials` from the command palette.

4. Bootstrap (idempotent; fails fast if the model is not listed by TrueForge):
   ```bash
   # macOS / Linux (bash, zsh)
   TRUEFORGE_CONNECTOR_URL="http://127.0.0.1:8765/mcp" \
   TRUEFORGE_MCP_TOKEN="<token from NotTheLeast: Copy MCP Connector Credentials>" \
   TRUEFORGE_MODEL="<model FQN already listed by TrueForge>" \
   node scripts/bootstrap-trueforge.mjs
   ```
   ```powershell
   # Windows (PowerShell)
   $env:TRUEFORGE_CONNECTOR_URL = "http://127.0.0.1:8765/mcp"
   $env:TRUEFORGE_MCP_TOKEN = "<token from NotTheLeast: Copy MCP Connector Credentials>"
   $env:TRUEFORGE_MODEL = "<model FQN already listed by TrueForge>"
   node scripts/bootstrap-trueforge.mjs
   ```

5. Reload and click the **NotTheLeast** Activity Bar icon.

## User Guide

### Views
- **Chat**: Send prompts, view streaming responses, approve tool calls. Create, rename, and switch named sessions. Transcripts stay per session in the webview; TrueForge IDs persist in SQLite.
- **Agent Activity**: Live agent timeline.
- **Tool Execution**: Tool requests, approvals, results.
- **Diagnostics**: Status, timing, token usage, GPU metrics, log export.
- **Context Assembly**: Evidence selection and budget visibility.

### Chat Workflow
- `Ctrl+Enter` sends a prompt.
- Approve/deny tool calls in approval cards.

### Inline Edit
Select code → `Ctrl+Alt+I` → enter instruction → review diff → approve hunks.

### Modes
- **Thinking**: Read-only. Agent inspects but cannot modify.
- **Tool**: Full agent with approval-gated mutations.

## Development

```powershell
npm test          # Run all tests
npx tsc --noEmit  # Type-check
npm run build     # Build extension and webview
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [PS Requirements](docs/PS_REQUIREMENTS.md)
- [Inline Edit](docs/INLINE_EDIT_FLOW.md)

## License

MIT