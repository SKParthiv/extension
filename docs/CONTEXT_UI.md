# Context Manager UI behavior

The Context Manager (`nottheleast.context`) provides complete lifecycle and state management for session context, the observation inbox, and the reusable context library.

## Features and Workflows

1. **Session & Token Overview:**
   - Active session selector, `+ New`, and `Rename` on Chat and Context Manager.
   - Non-empty title validation. Rename updates `updated_at` and keeps session ID, context memberships, and TrueForge mapping.
   - Empty-session, loading, unbound-runtime, and error banners. Active session indicator (`Active` / `Runtime unbound`).
   - Chat transcripts stored per application session in the webview. Switching shows that session's transcript only.
   - Context candidates isolated by session membership.
   - Create and switch blocked during a running turn or pending tool approvals.
   - Live assembly budget and token utilization indicator (`usedTokens / budget`).
   - Conflict warning banners showing disagreements between structured directives without auto-resolving.

2. **Independent Property Editing:**
   - **Priority:** `P0` (highest) to `P3` (lowest), or `Unset`.
   - **Scope:** `task`, `project`, or `global`.
   - **Status:** `active`, `inbox`, `deferred`, `archived`, `excluded`, or `resolved`.
   - **Pin:** Explicit toggle (`📌 Pinned` / `Pin`). Pinned active blocks take precedence in selection.
   - **Lock:** Explicit toggle (`🔒 Locked` / `🔓 Lock`). Locked blocks disable property editing, moving, or storing to prevent accidental modification.
   - All property mutations are completely independent; changing priority never modifies scope or status.

3. **Observation Inbox:**
   - Dedicated section displaying observations captured by tools or runtime.
   - Displays block provenance (`Provenance: ...`) and source metadata.
   - Features an explicit **Promote to Active** button.
   - **Strict Invariant:** Inactive and inbox blocks are never auto-promoted and never injected into model prompts.

4. **Library & Cross-Session Operations:**
   - **Store in Library:** Explicitly removes session membership and registers the block in the reusable Library with project/global visibility.
   - **Move:** Transfers membership to an explicitly selected destination session.
   - **Copy:** Clones the block with a new ID and creates a new membership in the explicitly selected destination session.
   - **Attach:** Adds a reusable Library entry to the current session (with `task` scope and `inbox` status).
   - **Restore:** Re-activates archived, deferred, or resolved blocks into the session Inbox.

5. **Safety and Integrity:**
   - Disables actions while in-flight to prevent double-submissions.
   - Fails safely on invalid actions (e.g. missing destination session) and renders user-facing error banners without corrupting local UI or database state.
   - Uses native VS Code theme variables (`--vscode-*`) and compact, responsive layouts.


