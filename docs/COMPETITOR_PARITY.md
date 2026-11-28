# Competitor Parity Analysis

This document audits behaviors from leading open-source AI coding assistants (Cline, Roo Code, Aider, Continue) and defines our policy: Adopt, Adapt, or Reject, strictly aligned with the TrueFoundry Forge-a-thon Product Specification and architectural constraints in `AGENTS.md`.

## Principles & Protected Architecture

1. **Context Engine Protected:** Our SQLite-backed Context Manager (sessions, blocks, library, P0–P3 priorities, deterministic budgeting, explicit Store/Move/Copy/Attach, observation Inbox) is our core differentiator. Competitor patterns that replace or subvert this engine are rejected.
2. **TrueForge Harness Ownership:** TrueForge owns sessions, turns, streaming, tool approvals, cancellation, and model interaction. We never call model providers directly, run independent agent loops, or introduce competing frameworks.
3. **Safety & Non-Destructive Operation:** We never auto-commit, stash, or overwrite user files. Native VS Code diff review, per-hunk approval, and hash-verified safe undo are mandatory.
4. **Local Budget & Privacy:** No cloud spend (₹0 initial budget), local Qwen3.5 9B target, and no mandatory external embedding services.

---

## Feature Audit & Parity Matrix

### 1. File and Symbol Mentions

- **Source Project:** Cline (`@file`, `@problems`, `@folder`), Continue (`@file`, `@code`, `@docs`)
- **Behaviour:** Inline auto-complete in chat prompt box for `#file` and `@symbol`, resolving paths/ranges and embedding referenced content into prompt context.
- **Verdict:** **Adapt**
- **Why:** Essential for developer ergonomics (PS p2 §3). Must adapt to route through our bounded prompt assembly (`formatPromptWithContext`) with visible token cost and character limits (`MAX_CHARS_PER_ATTACHMENT`), without overriding user priority blocks or silently blowing the token budget.
- **Implementation Location:** `webview/index.tsx` (mention popup and tag chip rendering), `src/shared/messages.ts` (`PromptAttachment`, `resolveAttachmentRequest`), `src/runtime/NotTheLeastController.ts` (`resolveAttachments`), `src/context/PromptContext.ts`.
- **Tests Needed:** Mention parser unit tests; path resolution and line-range slicing tests; token cost calculation tests; truncation bounds tests.

---

### 2. Repository Map and Symbol Discovery

- **Source Project:** Aider (Tree-sitter PageRank repo-map)
- **Behaviour:** Automatically generates a concise map of repository symbols, call graphs, and definitions to orient the model on large repos without loading whole files.
- **Verdict:** **Adapt**
- **Why:** PS p2 §2 and Flask Task B require discovering multi-file changes across large repos (~17k lines) without the user naming files. However, Aider's approach must be adapted: it must remain lightweight, local, use native VS Code symbol APIs (`vscode.executeWorkspaceSymbolProvider`) or regex fallback, consume only remaining budget, and **never** displace or reorder user-managed P0–P3 context blocks.
- **Implementation Location:** `src/context/RepoMap.ts`, `src/context/ContextAssembler.ts`, `src/mcp/WorkspaceTools.ts` (`get_symbols`).
- **Tests Needed:** Deterministic symbol ranking tests; token budget capping tests; independence tests verifying repo map is omitted when user context consumes full budget.

---

### 3. Search and Retrieval

- **Source Project:** Continue (ripgrep / BM25 search), Roo Code (regex workspace search)
- **Behaviour:** Keyword and regex search across workspace files to find relevant snippets for context assembly or agent tool calls.
- **Verdict:** **Adopt**
- **Why:** Required by PS p2 §2 (`search` tool) and PS p2 §3 (automatic retrieval under budget). Already partially present in `LocalRetriever.ts` and `WorkspaceTools.search_workspace`.
- **Implementation Location:** `src/context/LocalRetriever.ts`, `src/mcp/WorkspaceTools.ts`.
- **Tests Needed:** Keyword snippet extraction tests; ranking and deduplication tests; non-starvation tests when earlier snippets exceed budget.

---

### 4. Task History and Resume

- **Source Project:** Cline (persisted task conversations, state reload)
- **Behaviour:** Persists chat conversations, tool actions, and results across editor restarts, allowing users to inspect history and resume prior sessions.
- **Verdict:** **Adapt**
- **Why:** Essential for continuity. Adapted to use our existing SQLite `app_sessions` schema mapped to TrueForge session IDs, avoiding Cline's proprietary task JSON store.
- **Implementation Location:** `src/context/db/Database.ts`, `src/context/ContextService.ts`, `src/runtime/NotTheLeastController.ts`, `webview/index.tsx`.
- **Tests Needed:** Session creation, switching, persistence across reload; TrueForge session ID mapping recovery.

---

### 5. Checkpoints and Undo

- **Source Project:** Aider (git commits per turn, `git reset` undo), Cline (checkpoint commits / shadow git)
- **Behaviour:** Records file changes per turn and allows rolling back changes.
- **Verdict:** **Reject git commits; Adopt SafeUndo**
- **Why:** Standing rule: **Never** auto-commit, stash, or modify git state. Aider's automatic git manipulation is dangerous in production repos. Our `SafeUndo` verifies the before-and-after text and file hash directly in VS Code WorkspaceEdit without touching git history.
- **Implementation Location:** `src/edits/SafeUndo.ts`, `src/extension.ts` (`agent.undoEdit`).
- **Tests Needed:** Verify clean undo restores exact file contents; verify undo aborts safely if file was modified after edit.

---

### 6. Diff Review & Per-Hunk Approval

- **Source Project:** Roo Code (inline and split diff review with accept/reject per block)
- **Behaviour:** Proposed code modifications are broken into diff hunks; user can review changes visually and approve or reject hunks individually before disk write.
- **Verdict:** **Adopt**
- **Why:** Mandatory PS requirement (PS p2 §1, §4, A1). Already implemented with native `vscode.diff` and `EditProposal.ts`, but needs stale-edit hash verification to prevent race conditions.
- **Implementation Location:** `src/edits/EditProposal.ts`, `src/edits/VscodeDiffReview.ts`, `src/edits/InlineEditFlow.ts`.
- **Tests Needed:** Per-hunk approval matrix (accept hunk 1, reject hunk 2); file hash match verification before write; stale file hash rejection tests.

---

### 7. Tool Approval and Permissions

- **Source Project:** Cline / Roo Code (auto-approve toggles, read-only vs edit modes)
- **Behaviour:** Tool execution requires explicit approval in UI unless pre-approved or in an automated mode.
- **Verdict:** **Adapt**
- **Why:** PS p2 §2 and AGENTS.md mandate that Thinking mode is strictly read-only, and Tool mode mutations (`apply_hunk`, `run_command`) require approval. We adapt this through TrueForge's native approval mechanism (`turn.requires_approval` / `respondToApproval`) rather than an extension-owned bypass.
- **Implementation Location:** `src/runtime/TrueForgeRuntime.ts`, `src/mcp/ToolPolicy.ts`, `webview/index.tsx`.
- **Tests Needed:** Thinking mode denies mutating tools; Tool mode suspends for approval; approval / rejection signals delivered accurately to TrueForge.

---

### 8. Terminal Output and Cancellation

- **Source Project:** Cline (integrated terminal execution with streaming output and abort button)
- **Behaviour:** Commands run in VS Code terminal or child process; output streams in real time; cancel button immediately terminates process and agent turn.
- **Verdict:** **Adopt**
- **Why:** PS p2 §5 and Acceptance Gate A3 require immediate cancellation leaving workspace consistent. Command output must be bounded and secure (rejecting banned/destructive commands).
- **Implementation Location:** `src/tools/CommandPolicy.ts`, `src/mcp/WorkspaceTools.ts` (`run_command`), `src/runtime/TrueForgeRuntime.ts` (`cancel`), `src/runtime/NotTheLeastController.ts`.
- **Tests Needed:** Cancellation mid-stream test; command policy blacklisting tests; bounded buffer output tests.

---

### 9. Usage and Diagnostics

- **Source Project:** Cline (token counter, cost estimate), Roo Code (API metrics)
- **Behaviour:** Displays token counts, latency, and telemetry for each request.
- **Verdict:** **Adapt**
- **Why:** AGENTS.md standing rule: **Keep estimated and reported usage separate**. Competitors often conflate tokenizer estimates with reported model API usage. We maintain separate channels: pre-send estimated usage (from character/word heuristics) vs post-turn reported usage (from TrueForge turn events).
- **Implementation Location:** `src/shared/messages.ts` (`telemetryUpdate`, `contextAssembly`), `src/runtime/SharedState.ts`, `webview/index.tsx`.
- **Tests Needed:** Independent emission of estimated vs reported token counters; telemetry aggregation tests.

---

### 10. Project Rules and Reusable Workflows

- **Source Project:** Cline (`.clinerules`), Aider (`CONVENTIONS.md`), Continue (`.prompt` files)
- **Behaviour:** Repository-specific instructions automatically loaded into prompt context.
- **Verdict:** **Adapt into Context Library**
- **Why:** Competitors use flat files dumped blindly into every prompt. We adapt project rules into our SQLite Context Manager: rules can be stored in the Library with `scope: "project"` or `scope: "global"`, assigned explicit priorities (P0–P3), and deterministically selected under the token budget.
- **Implementation Location:** `src/context/ContextService.ts` (`library_entries`), `src/context/ContextSelector.ts`.
- **Tests Needed:** Library rule attachment tests; priority ordering of project rules vs task context; budget truncation tests.
