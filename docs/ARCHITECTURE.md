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

## Session Management & Persistence

- Application sessions (`s-*`) map 1:1 to TrueForge runtime sessions.
- TrueForge session IDs are persisted in SQLite (`app_sessions.trueforge_session_id`) **before** the UI treats initialization as ready (`SessionListItem.ready`).
- Failed TrueForge initialization keeps the application session row. Switching or the next bind retries runtime creation. No second application row is created.
- On activation, `hydratePersistedSessions` loads mappings into `runtimeSessionIds` and restores the last-touched session (`app_sessions.updated_at`, updated on switch via `touchSession`).
- Ordinary switching reuses the persisted TrueForge ID and never calls `runtime.createSession` when a mapping exists.
- Incomplete mappings (null TrueForge ID) bind on select when the runtime is available.
- Chat transcripts live in the webview keyed by application session ID. They survive in-memory switches in the same webview lifetime. Full task checkpoints are P07, not here.
- Context blocks stay isolated by `session_memberships`.
- Create and switch are rejected while a turn is running or while tool approvals are pending. Pending approvals stay in `pendingApprovals`.
- Runtime events are routed with `resolveAppSessionId` from the TrueForge session ID, not the currently selected UI session.
- Create, rename, and switch run through a serial session gate.

## Security and safety

- Bind local MCP only to loopback and require per-launch authentication.
- Keep TrueForge outbound protections enabled.
- Reject path traversal and symlink escapes in workspace tools.
- Do not write proposed edits before approval.
- Re-read file content and verify SHA-256 hashes immediately before applying each hunk; reject stale proposals and fail closed to prevent overwriting user edits.
- Support safe sequential hunk application by updating expected file hashes only upon verified writes.
- Never store credentials or secrets in source control.

