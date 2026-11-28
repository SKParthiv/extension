# Implementation State & Fix Queue

Date: 2026-11-23  
Target Repo: `SKParthiv/extension`  
Branch: `skparthiv-trueforge-integration-audit`

## Standing Rules Compliance

- One fix per invocation.
- Never fake completion. Provide verified test and command output evidence.
- Baseline: 19 test files passed (80 tests), TypeScript zero errors, build clean.

---

## Numbered Fix Queue

| ID | Title | Status | Description | Evidence / Blockers |
|---|---|---|---|---|
| **P01** | **Context eligibility bug** | **Complete** | Filter inactive context (`inbox`, `deferred`, `archived`, `excluded`, `resolved`) before prompt selection. Preserve priority and pin ordering. Add tests proving inactive blocks cannot enter prompt. | `npm test`: 19 passed, 86 passed; `src/context/ContextSelector.test.ts`, `src/context/ContextAssembler.test.ts`, `src/context/PromptContext.test.ts`. |
| **P02** | **Stale edit protection** | **Complete** | Verify original file hash immediately before applying each hunk. Reject stale proposals. Never overwrite newer user edits. | `npm test`: 19 passed, 92 passed; `src/edits/EditProposal.test.ts`, `src/edits/InlineEditFlow.test.ts`, `src/mcp/WorkspaceTools.test.ts`. |
| **P03** | **Context Manager UI** | **Complete** | Finish editing priority, scope, status, pin and lock. Keep independent. Finish Inbox promotion and explicit Store/Move/Copy/Attach actions. | `npm test`: 20 passed, 97 passed; `src/context/ContextManagerUI.test.ts`, `webview/index.tsx`, `webview/styles.css`. |
| **P04** | **Session and chat workflow** | **Complete** | Finish create, rename and switch sessions. Preserve session isolation and persistence. | `npm test`: 21 passed, 103 passed; `src/context/SessionManagement.test.ts`, `webview/index.tsx`. |
| **P05** | **Attachments** | Pending | Finish `#file` and `@symbol` resolution, previews, line ranges and bounded prompt injection. Show token cost. | Next queued item. |
| **P06** | **Repository map** | Pending | Build compact local symbol/dependency map. Deterministic ranking and small budget. Integrate as additional retrieval evidence, not replacing context engine. | Blocked on P05. |
| **P07** | **Task history and recovery** | Pending | Improve persisted task history, resume, diffs and safe checkpoints. Never auto-commit or overwrite user work. | Blocked on P06. |
| **P08** | **Tool execution** | Pending | Improve command safety, bounded output, failure reporting, cancellation and streaming. Thinking stays read-only. Mutations require approval. | Blocked on P07. |
| **P09** | **Runtime UI** | Pending | Finish streaming visibility, cancellation, lifecycle stages, diagnostics, token estimates and reported usage. | Blocked on P08. |
| **P10** | **Acceptance and documentation** | Pending | Test Flask Tasks A, B, C. Update README, architecture, features, gap matrix, product decisions, context docs. | Blocked on P09. |

---

## Active Fix: P01 — Context Eligibility Bug

### Problem Statement
Currently, `selectContext` in `src/context/ContextSelector.ts` does not filter out inactive context candidates. Any block attached to a session (including `inbox`, `deferred`, `archived`, `excluded`, `resolved`) can be ordered and selected into the active prompt context if budget permits, or unconditionally if `pinned: true`.

### Target Invariant
1. Inactive blocks (`inbox`, `deferred`, `archived`, `excluded`, `resolved`) must NEVER enter active prompt context.
2. Only blocks with `status === "active"` are eligible for selection.
3. Pinning may override token budget, but NEVER eligibility rules (a pinned `inbox` block remains ineligible).
4. Selection order for eligible blocks is preserved: `pinned -> priority (P0..P3) -> position -> id`.
5. Non-eligible blocks are filtered out before prompt selection.

### P01 Verification Evidence
- Changed files:
  - `src/context/ContextSelector.ts`: Added `isEligibleContext` checking `candidate.membership.status === "active"`; filtered candidates with `isEligibleContext` before sorting and budgeting.
  - `src/context/ContextSelector.test.ts`: Added unit tests verifying inactive block filtering, pinned inactive block exclusion, and priority/pin ordering preservation among active blocks.
  - `src/context/ContextAssembler.test.ts`: Added integration test proving inactive blocks are excluded from `assembleContext.selected`.
  - `src/context/PromptContext.test.ts`: Added end-to-end test proving inbox and other inactive blocks cannot enter `formatPromptWithContext` output even when pinned.
  - `docs/CONTEXT_SELECTION.md`: Documented context eligibility rules.
- Test Output:
  - `npm test`: 19 test files passed (86 tests total).
  - `npx tsc --noEmit`: 0 errors.
  - `npm run build`: built cleanly.

---

## Active Fix: P02 — Stale Edit Protection

### Problem Statement
Proposals generated against workspace files could be applied even if the file on disk or the active editor buffer had changed since the proposal was created. This created a race condition where newer user edits could be silently overwritten.

### Target Invariant
1. Cryptographic SHA-256 hash (`expectedHash`) must be verified immediately before applying any hunk or proposal.
2. If current file contents on disk or editor buffer do not match the expected hash, the proposal must be rejected immediately (`Stale proposal rejected`).
3. User edits are never overwritten.
4. When hunks are applied sequentially, `expectedHash` updates to the resulting content hash to allow safe subsequent hunk applications.

### P02 Verification Evidence
- Changed files:
  - `src/edits/EditProposal.ts`: Added `computeHash` (SHA-256), `originalHash`, `expectedHash`, and `expectedText` to `EditProposal`.
  - `src/edits/InlineEditFlow.ts`: Verified `currentHash === expectedHash` before applying approved proposal or hunk; added `applyApprovedHunk`.
  - `src/mcp/WorkspaceTools.ts`: Added `expectedHash` to `ProposedChange`; verified `currentHash === expectedHash` before applying hunk in `applyHunk`; updated `expectedHash` upon successful application.
  - `src/extension.ts`: Verified `beforeHash === expectedHash` in `applyHunk` editor integration before modifying buffer.
  - `src/edits/EditProposal.test.ts`: Added unit tests for cryptographic hashes on proposal creation.
  - `src/edits/InlineEditFlow.test.ts`: Added regression tests for sequential hunk application, stale proposal rejection, rejected hunk no-write, and failed write state integrity.
  - `src/mcp/WorkspaceTools.test.ts`: Added regression tests proving file changes before first hunk or between hunks reject the stale proposal and preserve user edits; verified failed write preserves expectedHash and unapproved status.
  - `docs/EDIT_PROPOSALS.md`, `docs/INLINE_EDIT_FLOW.md`, `docs/ARCHITECTURE.md`, `GAP_ANALYSIS.md`: Documented stale edit protection, multi-hunk sequential hashing, and conflict recovery.
- Test Output:
  - `npm test`: 19 test files passed (92 tests total).
  - `npx tsc --noEmit`: 0 errors.
  - `npm run build`: built cleanly.

---

## Active Fix: P03 — Context Manager UI

### Problem Statement
Context Manager UI lacked interactive controls for editing independent block properties (priority, scope, status, pin, lock), explicit Inbox promotion, explicit Library management (Store, Move, Copy, Attach, Restore), and conflict/budget visualization. Inactive blocks or unpromoted inbox items needed clear segregation from active blocks.

### Target Invariant
1. Priority (P0..P3, unset), Scope (task, project, global), Status (inbox, active, deferred, archived, excluded, resolved), Pin, and Lock are fully independent properties.
2. Inactive blocks and Inbox blocks are displayed in separate visual sections and never enter prompt context.
3. Inbox items are promoted only via explicit user action ("Promote to Active").
4. Library actions preserve precise semantics:
   - Store: removes session membership, persists in Library.
   - Move: moves session membership to target session.
   - Copy: clones block independently into target session.
   - Attach: links Library block to session in inbox status.
   - Restore: unarchives/re-links block back to session inbox.
5. Locked blocks cannot be edited, moved, or stored.
6. Actions are disabled during in-flight operations to prevent double submissions.

### P03 Verification Evidence
- Changed files:
   - `src/shared/messages.ts`: Added action contracts (`setPriority`, `setScope`, `setStatus`, `pin`, `unpin`, `lock`, `unlock`, `promote`, `restore`), payloads, and block provenance.
   - `src/runtime/NotTheLeastController.ts`: Added `getContextSnapshotSync()`, wired `selectSession` handling, and executed all context mutations via `handleContextAction` with snapshot broadcasting.
   - `src/webview/GenericViewProvider.ts`: Wired `selectSession` bridge to runtime controller.
   - `webview/index.tsx`: Built complete `ContextView` component rendering session switcher, budget assembly, active blocks, inbox blocks with provenance and explicit promotion, inactive blocks, and reusable library items with independent property editing and transfer modals.
   - `webview/styles.css`: Added styles using native VS Code theme variables, compact layout, disabled states, and badges.
   - `src/context/ContextManagerUI.test.ts`: Added 5 integration tests covering property persistence/independence, pin/lock toggling & locked protections, explicit Inbox promotion, Store/Move/Copy/Attach/Restore semantics, and safe handling of invalid destination sessions.
   - `docs/CONTEXT_UI.md`, `docs/FEATURES.md`: Documented interactive context manager workflows and UI controls.
- Test Output:
   - `npm test`: 20 test files passed (97 tests total).
   - `npx tsc --noEmit`: 0 errors.
   - `npm run build`: built cleanly.

---

## Active Fix: P04 — Session Management & Persistence

### Problem Statement
Session management lacked explicit user controls to create and rename sessions, hydration of application-to-TrueForge runtime session mappings across extension reloads/database reopens, isolation of chat message transcripts between sessions, and safety guards preventing session switching/creation from corrupting active turns.

### Target Invariant
1. Users can create named application sessions with matching TrueForge runtime sessions.
2. Users can rename existing sessions with non-empty validation and updated timestamps without modifying session IDs or context blocks.
3. Ordinary session switching reuses existing TrueForge session IDs from SQLite and never creates duplicate runtime sessions.
4. Application sessions, context blocks, and chat transcripts are strictly isolated per session.
5. Session creation and switching are rejected while a turn is actively running.
6. TrueForge runtime events (deltas, messages, tool approvals) are scoped and routed back to their originating application session.

### P04 Verification Evidence
- Changed files:
   - `src/context/ContextService.ts`: Added `renameSession` and `getSession` methods with non-empty title validation; added validation in `createSession`.
   - `src/shared/messages.ts`: Added `createSession`, `renameSession`, `sessionsList` message types; enriched `userMessage` and `sessionChanged` with session context.
   - `src/webview/GenericViewProvider.ts`: Wired `createSession` and `renameSession` webview messages to `NotTheLeastController`.
   - `src/runtime/NotTheLeastController.ts`: Hydrated `runtimeSessionIds` from SQLite on startup; implemented `handleCreateSession` and `handleRenameSession`; enforced running turn guard in session switching/creation; added `resolveAppSessionId` to scope agent runtime events to their originating application session.
   - `webview/index.tsx`: Added session selector, `+ New` session dialog, `Rename` session dialog, and per-session message storage in `ChatView`; added `+ New` and `Rename` controls to `ContextView`.
   - `src/context/SessionManagement.test.ts`: Added 6 unit/integration regression tests covering session creation, non-empty rename validation, session switching & context isolation, persistence across SQLite reopen without duplicate runtime session creation, active turn switching protection, and runtime event session scoping.
   - `docs/ARCHITECTURE.md`, `docs/FEATURES.md`, `docs/CONTEXT_UI.md`, `GAP_ANALYSIS.md`: Documented session management, persistence, chat isolation, and turn protection.
- Test Output:
   - `npm test`: 21 test files passed (103 tests total).
   - `npx tsc --noEmit`: 0 errors.
   - `npm run build`: built cleanly.
