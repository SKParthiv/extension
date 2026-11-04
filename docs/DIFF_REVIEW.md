# Native diff review

`VscodeDiffReview` adapts VS Code's document and command APIs to `DiffReviewService`, which opens the original and proposed text as untitled VS Code documents and delegates rendering to the built-in `vscode.diff` command. It never writes either document.

The service accepts an injectable API for tests. The editor integration must call it before applying approved hunks so the user can inspect the complete proposal in the native diff viewer.
