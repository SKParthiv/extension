# Product decisions

## Settled decisions

- Build an original VS Code extension; do not clone or fork Cline as the product.
- Inspect a pinned Cline commit only as a reference and record any narrowly reused component.
- TrueForge owns the agent loop, sessions, turns, streaming, approvals and tool orchestration.
- Use `@truefoundry/trueforge-sdk`; the extension must not call model providers directly.
- Keep the UI inside VS Code with a React Webview.
- Prefer native VS Code editor and diff APIs.
- Persist Context Manager state in local SQLite under VS Code global storage.
- Treat the Context Manager as a first-class MVP feature.
- Keep each session's context list separate from the reusable Context Library.
- Preserve explicit Move, Store, Attach and Copy semantics.
- Keep scope, priority and status independent.
- Put observations in Inbox; never auto-inject them.
- Show possible conflicts without silently rewriting user instructions.
- Select context deterministically under a visible token budget.
- Use local symbol and bounded text retrieval initially; no embeddings.
- Thinking mode is read-only.
- Tool mode mutations and commands require TrueForge approval.
- Edit proposals are non-mutating; every applied hunk requires separate approval.
- Provide per-hunk diff review and safe undo.
- Separate estimated usage from reported usage.
- Use local Qwen3.5 9B with ₹0 initial cloud spend.
- Do not download models or activate paid fallback without approval.

## Acceptance gates

- [ ] Inline edit through a real editor selection and native diff review.
- [ ] Agent mode discovers and changes at least three files without user-named implementation files.
- [ ] Deterministic context assembly with visible selected files, reasons and budget.
- [ ] Per-hunk diff review, accept/reject and undo.
- [ ] Streaming and cancellation through verified TrueForge APIs.
- [ ] Flask Task A at the required commit.
- [ ] Flask Task B at the required commit.
- [ ] Flask Task C at the required commit.

