# Project instructions

## Standing rules

1. Execute only the current prompt.
2. Never invent SDK APIs, event names, config keys or results. Read installed types and docs first. Names marked `lead` are unverified.
3. If a prerequisite is missing, report the blocker and stop.
4. The extension never calls a model provider. TrueForge owns the agent loop.
5. No cloud spend, no extra model downloads, no credentials in source control.
6. Prefer native VS Code APIs.
7. Never state a test passed without showing its output.
8. Final report: changed files, commands run, observed output, limitations, next prerequisite.

## Architecture constraints

- This is an independently maintained extension repository.
- TrueForge owns sessions, turns, streaming, approvals and tool orchestration.
- Use `@truefoundry/trueforge-sdk`; do not call model providers directly.
- Use a React Webview inside VS Code and native VS Code diff/editor APIs.
- Use local SQLite for Context Manager persistence.
- Use an in-process loopback MCP server only when its installed SDK and transport are verified.
- Do not use embeddings or add a second agent framework.
- Initial model and budget: local Qwen3.5 9B, ₹0 cloud budget.
- Thinking mode is read-only. Tool mode is approval-gated.
- Require per-hunk approval for edits.
- Keep estimated and reported usage separate.

## Evidence

Every implementation step must report changed files, commands run, observed output, limitations, and the next prerequisite. Do not claim a feature or acceptance gate is complete without direct evidence.

## Constitution immutability

`docs/PRODUCT_CONSTITUTION.md` is immutable by default. Only an explicit instruction from the owner authorizes amendments. AI agents must never override, extend or contradict its design decisions.

