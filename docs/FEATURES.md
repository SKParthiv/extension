# Feature backlog

Basis: `docs/TODO.md`, the acceptance gates in `docs/PRODUCT_DECISIONS.md`, and a code survey of this branch (`dark`, based on `skparthiv-trueforge-integration-audit` at `5d39f5c`). Items cite the file or doc they come from; nothing here is assumed about TrueForge or VS Code APIs without a source in the repo.

## Already implemented (present in source)

- Loopback MCP server: stateless HTTP transport, bearer token in SecretStorage, 8 registered tools, path-traversal and symlink guards (`src/mcp/McpServer.ts`, `src/mcp/WorkspaceTools.ts`).
- TrueForge runtime adapter: sessions, turns, streamed deltas, tool-approval events, cancellation (`src/runtime/TrueForgeRuntime.ts`).
- Inline edit command: selection → prompt → replacement → native VS Code diff review → per-hunk accept/reject → apply → safe undo (`src/edits/*`, `agent.inlineEdit` in `src/extension.ts`).
- Context Manager: SQLite persistence, deterministic budgeted selection, conflict surfacing, observation capture, local retrieval (symbols + bounded text) (`src/context/*`).
- Context Manager UI: full property editing (priority, scope, status, pin, lock), explicit observation Inbox with promote-to-active, reusable Library management (Store, Move, Copy, Attach, Restore) (`webview/index.tsx`, `src/runtime/NotTheLeastController.ts`).
- Session Management & Persistence: named create, non-empty rename, switch, last-active restore via `updated_at`, TrueForge ID persist-before-ready, retry of incomplete mappings, in-webview chat isolation, serial session ops, and reject switch during running turns or pending approvals (`src/context/ContextService.ts`, `src/runtime/NotTheLeastController.ts`, `webview/index.tsx`).
- React Webview: chat with streaming, thinking/tool mode, tool approval cards with Review Diff, context snapshot with Store/Re-attach, assembly summary (`webview/index.tsx`).
- Bootstrap script registering connector and saved agent through verified SDK methods (`scripts/bootstrap-trueforge.mjs`).

## Features to build

### A. Chat and attachments (TODO item 3)

1. **`#` / `@` file and context attachments in chat.** Parse mentions in the prompt box, resolve them to workspace files, symbols, or context blocks, and attach the resolved evidence before sending the turn. No mention parsing exists today; the prompt is sent as plain text (`sendPrompt` in `webview/index.tsx`).
2. **Attachment preview before send.** Show what a mention resolved to (path, line range, token estimate) so the user can drop attachments before the turn starts.

### B. Context Manager completion (TODO item 4)

3. **Editable context blocks.** [Implemented] Controls for priority (P0–P3, unset), scope (task, project, global), status (inbox, active, deferred, archived, excluded, resolved), pin and lock are wired with independent state persistence.
4. **Move and Copy UI wiring.** [Implemented] Wired explicit Store/Move/Attach/Copy/Restore semantics in the Context Manager UI with explicit session selectors.
5. **Observation Inbox UI.** [Implemented] Dedicated Inbox section displaying block provenance with explicit Promote to Active control.
6. **Session creation and renaming.** [Implemented] Added `createSession` and `renameSession` messages, full UI controls in Chat and Context views, and TrueForge ID synchronization.
7. **Auto-prioritized block generation.** Selection honors priority today (`docs/CONTEXT_SELECTION.md` flow), but nothing generates suggested priorities from capture content or retrieval evidence. Generate suggestions on capture; keep them user-editable per TODO item 4.

### C. Chat UI / user flow (TODO item 5)

8. **Usage display.** AGENTS.md requires estimated and reported usage to stay separate; neither is surfaced to the webview (no usage message in `src/shared/messages.ts`). Add both, clearly separated.
9. **Webview inline edit flow.** The `inlineEditRequest` message exists but has no webview affordance; inline edit is command-palette only (`src/extension.ts`). Add an entry point and progress/diff view inside the panel.
10. **In-chat diff review.** Approval cards open the native diff via `reviewDiff`; add inline hunk-level accept/reject inside the chat card so review does not require context switching.

### D. Inline edit completion (TODO item 2)

11. **Route inline-edit approvals through TrueForge.** The inline edit command approves hunks with local quick picks (`src/extension.ts`), bypassing the TrueForge `apply_hunk` approval triggers used by agent-mode edits. Unify so per-hunk approval semantics are identical in both paths.
12. **Streaming replacement preview.** `requestReplacement` accumulates deltas silently (`src/extension.ts`); show the replacement as it streams before the proposal is staged.
13. **End-to-end inline edit verification against a real configured agent.** Blocked: the local TrueForge instance exposes no configured agent and no Qwen3.5 9B model (`docs/SMOKE_RESULTS.md`).

### E. TrueForge feature coverage (TODO items 1 and 6)

14. **Runtime smoke suite.** Plain turns, structured tools, sequential tools, approval flow, and usage fields — explicitly deferred in `docs/SMOKE_RESULTS.md`; blocked on the same agent/model prerequisite as item 13.
15. **Agent-mode multi-file acceptance gate.** Agent mode discovers and changes at least three files without user-named implementation files (acceptance gate, `docs/PRODUCT_DECISIONS.md`).
16. **Streaming and cancellation gate.** Verify streamed deltas and cancellation against verified TrueForge APIs end to end (acceptance gate).
17. **Deterministic context assembly gate.** Selected files, reasons and budget visible per turn (acceptance gate; partially demonstrated by `contextAssembly` messages, needs runtime verification).

### F. Release hygiene

18. **Green local checks on this branch:** `npm test`, `npx tsc --noEmit`, `npm run build`.
19. **Flask Tasks A, B, C** at their required commits (acceptance gates; external milestones).

## Prerequisites / current blockers

- Local TrueForge server with a saved agent and the Qwen3.5 9B model listed. The smoke run found only `dead-endpoint/dead-model` and `ollama/qwen2.5-coder:7b-instruct` (`docs/SMOKE_RESULTS.md`). This blocks items 13–17.
- Push credentials for the `darklordgit29-ship-it` GitHub profile. Repo-local git identity is set to that profile; the macOS keychain holds no credential for it and `gh` is authenticated only as `basanth-p`. This blocks publishing commits from this branch.
