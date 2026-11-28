# Project Specification — NotTheLeast

*Target architecture derived from the Product Constitution (`docs/PRODUCT_CONSTITUTION.md`). Distinguishes target from current implementation. Undecided matters marked `OPEN — OWNER DECISION REQUIRED`.*

---

## 1. Product Identity

**Constitution basis:** § 1 — NotTheLeast is a developer operating layer that abstracts codebases, knowledge, tasks, dependencies, agents and execution.

**Target:** NotTheLeast provides a unified abstraction over the developer's workspace — files, symbols, dependencies, task context, agent capabilities, and execution history. The abstraction is the authoritative interface for all agentic operations.

**Current:** The extension connects to a single TrueForge agent and delegates prompt dispatch, tool calls, and streaming directly from the VS Code controller. Workspace abstraction is limited to file-based context assembly and MCP tool registration. No unified abstraction over dependencies, execution history, or multi-agent coordination exists.

## 2. Intent and Work Management

**Constitution basis:** § 2.2 — NotTheLeast defines **what** must happen: intent, objectives, constraints, dependencies, permissions and acceptance criteria. § 2.8 — The user manages intent and outcomes; NotTheLeast manages work, knowledge and control flow.

**Target:** A structured intent specification format that captures:
- **Intent:** What the user wants to achieve (free-form + structured).
- **Objectives:** Measurable sub-goals.
- **Constraints:** Boundaries the execution layer must respect.
- **Dependencies:** Preconditions that must be satisfied.
- **Permissions:** Resource and action authorizations.
- **Acceptance criteria:** Verifiable conditions that define success.

Work items are created, persisted, updated, and closed through NotTheLeast. Each work item carries a full intent specification. No agent may proceed without an explicit intent definition.

**Current:** Prompt dispatch sends free-form user text to the TrueForge agent. No structured intent specification, objectives, constraints, or acceptance criteria are captured. Dependencies are not tracked. Permissions are limited to per-hunk approval gates on edits.

## 3. Workspace Abstraction

**Constitution basis:** § 1 — abstracts codebases, knowledge, tasks, dependencies, agents and execution.

**Target:** A deterministic workspace model that maps:
- File paths and their content (with hash-verified snapshots).
- Language symbols (functions, classes, variables, types).
- Project dependencies (package manifests, import graphs).
- Task context (active, deferred, resolved, archived).
- Agent capabilities (registered tools, runtime connections).
- Execution history (turns, approvals, edits, rollbacks).

The workspace abstraction is the single source of truth for all operations. All reads and writes pass through it. It enforces permissions and produces verifiable provenance records.

**Current:** Workspace is accessed ad-hoc via VS Code APIs (`vscode.workspace.findFiles`, `vscode.workspace.openTextDocument`). File snapshots are hash-verified only at the point of hunk application (in `extension.ts` `applyHunk`). No unified workspace model exists. Symbol resolution uses VS Code's providers directly.

**OPEN — OWNER DECISION REQUIRED:** Should the workspace abstraction be an in-process class, a separate service process, or an MCP server?

## 4. Knowledge and Context Management

**Constitution basis:** § 2.6 — Facts, assumptions, inferences, decisions and verified results must remain distinguishable.

**Target:** A context management system that captures four distinct knowledge categories:
- **Facts:** Verified, sourced information (contents of files, known API signatures, confirmed test results).
- **Assumptions:** Unverified beliefs with explicit confidence labels.
- **Inferences:** Conclusions drawn from facts and assumptions, with traceable reasoning.
- **Decisions:** Approved changes with provenance (who approved, when, which acceptance criteria were met).

Each knowledge entry carries:
- Source or provenance.
- Timestamp.
- Confidence or verification status.
- Links to related work items.
- Token estimate for budget management.

Context assembly selects entries based on relevance, budget, and verification status. Facts always take precedence over assumptions in assembly.

**Current:** SQLite-backed `ContextService` stores `context_blocks` with `source_type`, `provenance`, `token_estimate`. Membership tracks scope (`task`/`project`/`global`), priority (`P0`–`P3`), status (`inbox`/`active`/`deferred`/`archived`/`excluded`/`resolved`), and pin/lock flags. However, there is no distinction between facts, assumptions, inferences, and decisions. Verification status is not tracked. Provenance is a free-text string with no structured guarantees.

**OPEN — OWNER DECISION REQUIRED:** Should the knowledge model add explicit fact/assumption/inference/decision type discrimination? Should verification status be a separate field?

## 5. Deterministic Control and Scheduling

**Constitution basis:** § 2.1 — The abstraction and control layer must be deterministic and reproducible.

**Target:** Given the same workspace state, intent specification, and context, the control layer must produce identical outputs (the same plan, the same tool call sequence, the same acceptance criteria evaluation). Reproducibility is achieved through:
- Hash-verified snapshots of all input state.
- Deterministic context assembly (sorted, bounded, repeatable selection).
- Explicit scheduling: work items are sequenced through a deterministic scheduler that respects dependencies, priorities, and permissions.
- Logging every input, decision, and output for replay.

**Current:** No deterministic scheduling exists. Context assembly uses `assembleContext` with budget constraints but does not guarantee deterministic selection (files are loaded asynchronously, ordering depends on VS Code file system enumeration). No replay mechanism. No input state snapshot.

## 6. Agentic Execution

**Constitution basis:** § 2.3 — The execution layer may use agents extensively and autonomously decides **how** to accomplish the defined objective. § 2.4 — Agents cannot silently redefine objectives, priorities, constraints or acceptance criteria. § 2.7 — Agents are execution components, never the authority on project truth.

**Target:** The execution layer:
- Receives a fully-defined intent specification from the control layer.
- Selects and invokes tools to fulfill the intent.
- Streams progress events (tool calls, model messages, completion).
- Never modifies the intent specification.
- Reports results and provenance back to the control layer.
- Is provider-independent — the same abstraction works with TrueForge, OpenAI, Anthropic, or local models.

Multiple agents may work concurrently or sequentially on different work items, coordinated by the scheduler.

**Current:** A single `TrueForgeRuntime` wraps the TrueForge SDK. Execution is tightly coupled to TrueForge's session/turn/stream model. The `NotTheLeastController` manages event routing directly. There is no provider abstraction — changing the agent backend requires rewriting `TrueForgeRuntime`. Agent capabilities are not enumerated or abstracted. No multi-agent coordination exists.

**OPEN — OWNER DECISION REQUIRED:** Should multi-agent coordination be in-scope for v1?

## 7. Verification and Provenance

**Constitution basis:** § 2.5 — Final implementations may be nondeterministic, provided they satisfy the defined contract. § 2.6 — Facts, assumptions, inferences, decisions and verified results must remain distinguishable.

**Target:** Every change to the workspace must be:
1. Proposed (with diff and hash-verified before/after state).
2. Approved (per-hunk or per-change, with user decision recorded).
3. Applied (with provenance: who, when, which intent, which acceptance criteria).
4. Verifiable (the result can be checked against the acceptance criteria).

Provenance records form an append-only log that enables:
- Undo/redo of any approved change.
- Audit of which intent produced which change.
- Replay of any past session for debugging.

**Current:** `SafeUndoService` records applied edits with file path, before/after text. `EditProposal` supports per-hunk approval. However, proposals are not linked to intents or acceptance criteria. The undo log is in-memory-only (not persisted). Provenance does not include which intent or work item motivated the change.

**OPEN — OWNER DECISION REQUIRED:** Should provenance be persisted to the SQLite database instead of held in memory? Should proposals be linked to intent specifications?

## 8. User-Facing Experience

**Constitution basis:** § 2.8 — The user manages intent and outcomes; NotTheLeast manages work, knowledge and control flow.

**Target:** The user interacts through:
- A **chat panel** for composing intent and reviewing results.
- A **work item view** showing pending, active, and completed work with their intent specifications.
- A **context assembly view** showing what knowledge was selected, omitted, and why.
- A **diff review panel** for per-hunk approval of proposed changes.
- A **provenance log** showing every change and its originating intent.

All views are driven by the deterministic control layer, not by ad-hoc agent output.

**Current:** Five webview panels exist (Chat, Agent Activity, Tool Execution, Diagnostics, Context Assembly). They display data streamed from the TrueForge runtime in real-time. The views are reactive (driven by broadcasts from `NotTheLeastController`) rather than model-driven by a deterministic intent specification. No work item view exists.

**OPEN — OWNER DECISION REQUIRED:** Should the Chat view evolve to an intent composition interface with structured fields for objectives, constraints, and acceptance criteria?

## 9. Provider Independence

**Constitution basis:** § 1 — abstracts agents and execution.

**Target:** The execution layer defines a generic `AgentRuntime` interface that any provider can implement. The control layer never imports provider-specific SDKs. Provider configuration is:
- Provider name (e.g., `trueforge`, `openai`, `anthropic`, `local-qwen`).
- Endpoint URL.
- Authentication (token, API key, or none for local).
- Model name (for providers that expose model selection).
- Capability manifest (tools enabled, mode support, streaming support).

Switching providers requires only configuration changes.

**Current:** `AgentRuntime` is an abstract interface in `AgentRuntime.ts` with methods `createSession`, `sendTurn`, `setMode`, `getMode`, `getConnectionState`, `resetSession`, `cancel`, `respondToApproval`, `onEvent`. `TrueForgeRuntime` is the sole implementation. The interface is biased toward TrueForge's session/turn paradigm (e.g., `sessionId` in every event, `respondToApproval` tied to TrueForge's `ApprovalDecision` type). Provider independence is aspirational but not yet achieved.

**OPEN — OWNER DECISION REQUIRED:** Should the `AgentRuntime` interface be redesigned to be provider-agnostic (removing TrueForge-specific types)? What is the priority order for additional providers (OpenAI, Anthropic, local model via MCP)?

---

## Appendix: Target vs Current Mapping

| Domain | Target | Current |
|---|---|---|
| Intent specification | Structured: intent, objectives, constraints, deps, permissions, acceptance criteria | Free-form user text only |
| Workspace abstraction | Unified, deterministic model with hash-verified snapshots | Ad-hoc VS Code API calls |
| Knowledge management | Facts/assumptions/inferences/decisions with verification status | Flat context blocks with free-text provenance |
| Deterministic control | Reproducible state snapshots, deterministic scheduling, replay | No scheduling, non-deterministic assembly |
| Agent execution | Provider-independent runtime, multi-agent coordination | Single TrueForge runtime, tight coupling |
| Verification & provenance | Append-only log, intent-linked proposals, persisted | In-memory undo, proposals not linked to intents |
| User experience | Intent composition, work item view, provenance log | Reactive streaming views, no work item view |
| Provider abstraction | Generic interface, config-driven provider selection | TrueForge-biased interface, single implementation |

---

*This specification derives from the Product Constitution and does not override it. Where ambiguity exists, the Constitution prevails.*