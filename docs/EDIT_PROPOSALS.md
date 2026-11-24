# Edit proposals and hunk approval

`createEditProposal` computes a line-based proposal without modifying the workspace. Each contiguous change is a separate hunk with an independent approval flag. It calculates and retains cryptographic SHA-256 hashes (`originalHash` and `expectedHash`) for the original file content.

`applyApprovedHunks` reconstructs a candidate result from the original text. With no approvals it returns the original text; only explicitly approved hunks contribute proposed lines. A later editor integration must still show the resulting text through native VS Code diff APIs before writing it.

## Stale edit protection and conflict recovery

- **Cryptographic Hash Verification:** Proposals capture SHA-256 hashes (`originalHash` and `expectedHash`). Immediately prior to writing each hunk or approved proposal, the target file is read from disk or the active editor buffer and compared against `expectedHash`.
- **Conflict Detection & Fail-Closed:** If the current hash does not match `expectedHash` (e.g. from concurrent user typing, external git pull, or formatting), the write is immediately rejected (`Stale proposal rejected` / `InlineEditConflictError`). No partial or unapproved modifications touch disk.
- **Multi-Hunk Sequencing:** Upon successful application of an approved hunk, `expectedHash` is updated to the resulting file content hash. Subsequent approved hunks remain valid against the updated hash. Any external edit between hunk approvals invalidates subsequent hunk writes.
- **Failed Write Integrity:** If a write operation fails (e.g., I/O failure or editor rejection), `expectedHash` and approval state are left untouched, preserving the file without state corruption.
- **Recovery:** When a proposal is rejected as stale, user changes are fully preserved. The user or agent generates a fresh proposal against the current file state.

