# Safe undo

`SafeUndoService` provides scoped undo for an approved edit without assuming that
the workspace stayed unchanged after the edit.

- Each applied edit records its exact `beforeText` and `afterText`.
- Undo reads the current file before writing anything.
- The write is refused when the current text does not exactly match the recorded
  approved result.
- A successful undo restores the exact original text and consumes the record.
- Unknown, duplicate, no-op, or already-consumed records are rejected.

The service is storage-agnostic so the native VS Code adapter can supply the
workspace read/write boundary later without weakening the concurrency check.
