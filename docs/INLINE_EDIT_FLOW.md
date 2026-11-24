# Inline edit flow

The inline-edit boundary is deliberately split into four steps:

1. Read the active document and selection.
2. Create a non-mutating `EditProposal` containing the full proposed document.
3. Open the proposal through the native VS Code diff-review adapter.
4. Apply only explicitly approved hunks after re-reading the document.

The apply step refuses to write when the document changed after proposal
creation, verifying cryptographic SHA-256 hashes immediately before applying
each hunk or proposal to ensure newer user edits are never overwritten. Successful
writes are recorded by `SafeUndoService` with the exact before and after text.

Model-generated replacement text is supplied by the TrueForge runtime layer.
Until a configured TrueForge agent and approval UI are available, this module
is tested with deterministic replacement text and does not call a model provider
directly.
