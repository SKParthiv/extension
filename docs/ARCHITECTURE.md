# Architecture

## Boundaries

The VS Code extension owns the Webview UI, typed message bridge, Context Manager persistence and services, repository retrieval, editor integration, proposal/diff review, and the lifecycle of the local MCP server.

TrueForge owns agent sessions, turns, model interaction, streamed events, tool orchestration, approvals and cancellation semantics. The extension talks to TrueForge through a narrow runtime adapter and never calls a model provider directly.

## Components

- **Extension host:** activation, commands, settings, runtime adapter, Context Manager services, repository retrieval and editor integration.
- **React Webview:** session UI, Context Manager UI, streamed progress, approvals and diff-review controls.
- **Typed bridge:** discriminated messages between the extension host and Webview.
- **TrueForge runtime adapter:** verified SDK calls mapped to internal session, stream, approval, usage and error events.
- **Context Manager:** local SQLite database containing sessions, blocks, memberships and Library state.
- **Repository retrieval:** VS Code symbol/document providers with bounded workspace-relative text search fallback.
- **MCP server:** loopback-only, authenticated, extension-owned tools; mutating tools are approval-gated and mode-restricted.
- **Edit pipeline:** non-mutating proposals, native VS Code diff review, one approval per hunk, verified apply and scoped undo.

## Context flow

1. The user selects or manages session context in the Context Manager.
2. Explicit file and symbol references are resolved through VS Code APIs.
3. Deterministic selection admits only eligible active blocks for the current session.
4. The selected context and reasons are shown in the UI and sent through the TrueForge runtime.
5. Observations return to the current session Inbox and are not injected automatically.

## Security and safety

- Bind local MCP only to loopback and require per-launch authentication.
- Keep TrueForge outbound protections enabled.
- Reject path traversal and symlink escapes in workspace tools.
- Do not write proposed edits before approval.
- Re-read file content and verify hashes immediately before applying hunks.
- Never store credentials or secrets in source control.

