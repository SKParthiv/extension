# Gap Analysis

This matrix maps the requirements from the Product Specification (PDF) to the current implementation state.

## Acceptance Gates

| Requirement | Status | Source Files | Required Changes | Verification Method |
|---|---|---|---|---|
| **Inline edit through a real editor selection and native diff review** | [In Progress] | `src/extension.ts`, `src/edits/InlineEditFlow.ts` | Ensure full loop: selection -> proposal -> diff -> approval -> apply. | Run `agent.inlineEdit` command in VS Code. |
| **Agent mode discovers and changes at least three files without user-named implementation files** | [Pending] | `src/mcp/McpServer.ts`, `src/mcp/WorkspaceTools.ts` | Verify all 8 tools work correctly for agent. | Run agent in "tool" mode with a multi-file change request. |
| **Deterministic context assembly with visible selected files, reasons and budget** | [Complete] | `src/context/ContextAssembler.ts`, `src/context/ContextSelector.ts`, `webview/index.tsx`, `src/runtime/NotTheLeastController.ts` | Complete Context Manager UI with budget assembly, active/inbox/inactive blocks, library, and independent property editing. | Inspect Context Manager webview and `ContextManagerUI.test.ts`. |
| **Per-hunk diff review, accept/reject and undo** | [Complete] | `src/edits/EditProposal.ts`, `src/edits/SafeUndo.ts`, `src/edits/InlineEditFlow.ts`, `src/mcp/WorkspaceTools.ts` | Stale edit protection verified with SHA-256 hash checking before each hunk write. | Unit tests in `EditProposal.test.ts`, `InlineEditFlow.test.ts`, `WorkspaceTools.test.ts`. |
| **Streaming and cancellation through verified TrueForge APIs** | [Pending] | `src/runtime/TrueForgeRuntime.ts` | Verify `createTurnStream` and `cancel` calls. | Monitor network/SDK logs during turn execution. |
| **Flask Task A** | [Pending] | - | Identify tasks from PDF. | Complete and verify task A. |
| **Flask Task B** | [Pending] | - | Identify tasks from PDF. | Complete and verify task B. |
| **Flask Task C** | [Pending] | - | Identify tasks from PDF. | Complete and verify task C. |

## Functional Requirements

| Requirement | Status | Source Files | Required Changes | Verification Method |
|---|---|---|---|---|
| **Session Management** | [Complete] | `src/runtime/NotTheLeastController.ts`, `src/context/ContextService.ts`, `webview/index.tsx` | Named create/rename/switch, SQLite TrueForge mapping, last-active restore, chat/context isolation, pending-turn protection. Chat history is in-webview only until P07. | `src/context/SessionManagement.test.ts`. |
| **Context Manager Persistence** | [Complete] | `src/context/db/Database.ts` | None. | Verify DB file existence/persistence. |
| **MCP Tool Pipeline** | [Partial] | `src/mcp/McpServer.ts`, `src/mcp/WorkspaceTools.ts` | Verify all 8 tools. | Verify tool execution via agent. |
| **Safe Undo** | [Complete] | `src/edits/SafeUndo.ts` | None. | Use `agent.undoEdit` command. |
| **Context Conflict Detection** | [Complete] | `src/context/ContextConflicts.ts` | None. | Verify conflicts show in UI. |
| **Local Retrieval** | [Complete] | `src/context/LocalRetriever.ts` | None. | Verify snippets in prompt. |
| **Model Configuration** | [Pending] | `src/runtime/TrueForgeRuntime.ts` | Configure local Qwen3.5 9B. | Verify Qwen3.5 is used in runtime. |
| **Approval Policy Enforcement** | [Pending] | `src/mcp/ToolPolicy.ts` | Ensure policy is checked for all tools. | Verify non-approved tool calls fail. |

## Non-Functional Requirements

| Requirement | Status | Source Files | Required Changes | Verification Method |
|---|---|---|---|---|
| **Security (No path traversal)** | [Pending] | `src/mcp/WorkspaceTools.ts` | Verify `resolvePath` logic. | Attempt to access `../` files. |
| **Reliability (Safe Undo)** | [Complete] | `src/edits/SafeUndo.ts` | None. | Verify undo safety. |
| **UI Polish (VS Code Theme)** | [Pending] | `webview/index.tsx`, `webview/styles.css` | Complete UI elements. | Visual inspection. |
| **Reproducible Dev Workflow** | [Pending] | `package.json`, `esbuild.js` | Create `demo:preflight`. | Run `npm run demo:preflight`. |

## Infrastructure and Integration

| Requirement | Status | Source Files | Required Changes | Verification Method |
|---|---|---|---|---|
| **TrueForge SDK Version 0.183.0** | [Pending] | `package.json` | Verify and update. | Check `node_modules` or `package.json`. |
| **Local Qwen3.5 9B Availability** | [Pending] | - | Ensure local model is configured. | Verify via `TrueForge: list_models`. |
| **MCP Loopback Auth** | [Pending] | `src/mcp/McpServer.ts` | Verify token logic. | Verify 401 for unauthorized. |
| **Demo Workspace Prepared** | [Pending] | - | Create demo folder/files. | Verify demo workspace setup. |
| **Demo Preflight Workflow** | [Pending] | `package.json` | Implement `npm run demo:preflight`. | Run `npm run demo:preflight`. |
| **Video Walkthrough Plan** | [Pending] | `docs/VIDEO_WALKTHROUGH.md` | Create walkthrough plan. | Review plan. |
