# Core Architecture — NotTheLeast

*Target architecture derived from the Product Constitution (`docs/PRODUCT_CONSTITUTION.md`). Distinguishes target from current implementation. Undecided matters marked `OPEN — OWNER DECISION REQUIRED`.*

---

## 1. Architectural Overview

The system has three horizontal layers and one cross-cutting vertical concern:

```
┌─────────────────────────────────────────────────────┐
│                   User-Facing Layer                  │
│  (VS Code webviews: Chat, Work Items, Context,       │
│   Diff Review, Provenance Log)                       │
├─────────────────────────────────────────────────────┤
│              Abstraction & Control Layer              │
│  (Intent Spec, Work Scheduler, Workspace Model,       │
│   Context Manager, Provenance Recorder)               │
│  ★ Deterministic, reproducible, owner of truth        │
├─────────────────────────────────────────────────────┤
│                 Execution Layer                        │
│  (Agent Runtime adapters: TrueForge, OpenAI, etc.)    │
│  ★ Autonomously decides HOW, never WHAT               │
├─────────────────────────────────────────────────────┤
│              VS Code Extension Host                    │
│  (Activation, MCP server, commands, file I/O)         │
└─────────────────────────────────────────────────────┘
         ▲                                               │
         └──── Cross-cutting: Provenance & Logging ─────┘
```

**Discipline:** The control layer never imports provider SDKs. The execution layer never modifies intent specs. The user layer never bypasses the control layer to reach execution directly.

## 2. Abstraction & Control Layer

### 2.1 Intent Specification System

**Target:** A structured record type that captures every aspect of a work item:

```
IntentSpec {
  id: string (UUID)
  title: string
  intent: string (free-form description)
  objectives: Objective[]  // measurable sub-goals
  constraints: Constraint[] // boundaries (permissions, resource limits)
  dependencies: Dependency[] // preconditions
  permissions: Permission[] // resource/action authorizations
  acceptanceCriteria: AcceptanceCriterion[] // verifiable conditions
  parentIntentId: string | null // for sub-tasks
  status: "draft" | "active" | "blocked" | "completed" | "failed" | "cancelled"
  createdAt: timestamp
  updatedAt: timestamp
}
```

The intent spec is the contract between the user and the execution layer. It is created by the control layer, approved by the user, and passed (read-only) to the execution layer.

**Current:** No IntentSpec type exists. The closest analogy is the free-form `text` passed to `handlePrompt()` in `NotTheLeastController`.

**OPEN — OWNER DECISION REQUIRED:** Should IntentSpec be persisted in SQLite alongside `app_sessions`? Should each session have exactly one IntentSpec, or multiple?

### 2.2 Work Scheduler

**Target:** A deterministic scheduler that:
1. Maintains a queue of intent specifications ordered by dependencies, priority, and creation time.
2. Assigns work items to available execution slots.
3. Blocks execution when dependencies are unsatisfied or permissions are missing.
4. Records every scheduling decision with a deterministic hash of the input state.

The scheduler does not decide HOW. It decides WHEN and WHAT, and hands off to the execution layer.

**Current:** No work scheduler exists. The controller dispatches prompts immediately to the TrueForge runtime. No queue, no dependency resolution, no permission checks prior to dispatch.

**OPEN — OWNER DECISION REQUIRED:** In-process job queue or external scheduler? Should scheduler state be persisted in SQLite?

### 2.3 Workspace Model

**Target:** A deterministic, hash-verified snapshot of the entire workspace at a point in time:

```
WorkspaceSnapshot {
  rootPath: string
  files: Map<relativePath, FileSnapshot>
  symbols: Map<symbolName, SymbolInfo[]>
  dependencies: DependencyGraph
  toolRegistry: ToolManifest
  agentConnections: AgentConnection[]
  snapshotHash: string
  createdAt: timestamp
}
```

All reads by the control layer and execution layer go through the current snapshot. Writes produce a new snapshot with updated hashes. The snapshot is the source of truth for deterministic replay.

**Current:** No workspace model exists. Files are read on-demand via `vscode.workspace.openTextDocument`. `loadWorkspaceFiles()` in `NotTheLeastController.ts` loads up to 20 files at a time with no snapshot semantics. The MCP server's `applyHunk` callback computes hashes ad-hoc during hunk application.

**OPEN — OWNER DECISION REQUIRED:** Does the workspace model need its own storage, or can it derive from VS Code APIs on-demand with a caching layer? Should it support workspace folding across multiple VS Code workspace roots?

### 2.4 Context Manager

**Target:** A knowledge management subsystem that:
1. Stores entries with explicit type discrimination: fact, assumption, inference, decision.
2. Each entry carries structured provenance (source, timestamp, verification status, confidence score).
3. Context assembly is deterministic: given the same budget and query, it returns the same selection.
4. Facts are prioritized over assumptions. Decisions are included only for relevant work items.
5. Conflicts (contradictory facts, or a fact contradicting an assumption) are detected and surfaced.

**Current:** `ContextService` stores flat `context_blocks` with free-text `provenance`. No type discrimination. `ContextSelector` and `ContextAssembler` perform relevance-based selection with a budget but without deterministic guarantees. `ContextConflicts` detects conflicts between two blocks with the same key, but does not distinguish fact vs assumption contradictions.

**OPEN — OWNER DECISION REQUIRED:** Add type field to `context_blocks` or create separate tables for facts, assumptions, inferences, and decisions?

### 2.5 Provenance Recorder

**Target:** An append-only log recording:
1. Every intent specification created, modified, or completed.
2. Every work item scheduling decision.
3. Every tool call invoked (which tool, with which arguments, by which agent).
4. Every edit proposed, approved, or rejected (with diffs and hashes).
5. Every workspace snapshot hash.

The log is deterministic: same inputs produce the same log entries. Log entries are linked by intent ID, session ID, and snapshot hash for full auditability.

**Current:** `NotTheLeastLogger` captures diagnostics-level events to a circular buffer. `SharedRuntimeState` records timing and activity events. `SafeUndoService` records applied edits in memory. None of these are append-only or linked to intents or snapshots. No deterministic replay is possible from current logs.

## 3. Execution Layer

### 3.1 Provider-Independent Agent Runtime Interface

**Target:** A generic runtime contract that any AI provider can implement:

```
AgentRuntime {
  createSession(config: SessionConfig): Promise<Session>
  sendMessage(sessionId, message: Message): AsyncIterable<AgentEvent>
  getCapabilities(): AgentCapabilities
  cancel(sessionId): Promise<void>
  setMode(mode: AgentMode): void
  getConnectionState(): ConnectionState
  onEvent(listener): Disposable
}
```

Where `AgentEvent` is a discriminated union with provider-neutral types:
- `model.message.delta` — streaming text/reasoning delta.
- `model.message` — complete model message.
- `tool.invocation` — tool call requested (with parsed arguments).
- `tool.result` — tool execution result.
- `tool.approval_required` — user approval needed for a tool call.
- `turn.completed` — turn finished with final state.
- `usage` — token consumption report.
- `error` — error event.
- `connection.changed` — connection state transition.

No provider-specific types leak into the event union. Provider SDKs are imported only within adapter implementations.

**Current:** `AgentRuntime` interface in `AgentRuntime.ts` imports `@truefoundry/trueforge-sdk` types (`ApprovalDecision`, `TurnDoneEventState`, `TurnUpdateEventState`). `TrueForgeRuntime` is the only adapter. The interface is biased toward TrueForge's session/turn paradigm.

**OPEN — OWNER DECISION REQUIRED:** Redesign `AgentRuntime` to remove TrueForge type dependencies. Should `sendTurn` become `sendMessage` with a structured `Message` type instead of raw text?

### 3.2 Agent Lifecycle

**Target (per agent):**
1. **Bootstrap:** Load tool manifest, connect to provider endpoint, authenticate.
2. **Configure:** Set mode (thinking/tool), budget, permissions.
3. **Execute:** Receive intent spec, run turn(s) using provider, stream events back.
4. **Complete:** Return final output and usage report. Agent self-declares completion or failure.
5. **Teardown:** Release resources, disconnect.

**Current:** `TrueForgeRuntime.create()` connects to the TrueForge backend. `sendTurn()` starts a stream that is consumed until `turn.done`. No tool manifest is fetched (MCP tools are registered separately). No explicit lifecycle stages beyond create/send/cancel.

### 3.3 Tool Registry

**Target:** A central registry of all available tools with:
- Tool name, description, input schema.
- Required permissions.
- Execution constraints (timeout, file system access, network access).
- Runtime to which the tool belongs.
- Invocation history linked to provenance log.

The control layer enforces permissions before forwarding tool calls to the execution layer.

**Current:** Tools are registered ad-hoc: MCP server tools in `McpServer.ts`, workspace tools in `WorkspaceTools.ts`, command tools in `CommandPolicy.ts`. No central registry. Permissions are checked per-tool-call via `ToolPolicy`. No linkage between tool invocations and provenance.

**OPEN — OWNER DECISION REQUIRED:** Should tool registry be part of the workspace model or a separate subsystem?

## 4. User-Facing Layer

### 4.1 View Architecture

**Target:** Each webview renders state from the control layer via a model-driven subscription pattern:
1. The control layer publishes a typed state DTO for each view.
2. The webview subscribes and receives incremental updates.
3. User actions (intent creation, approval, context management) are sent as typed messages to the control layer.
4. The control layer processes actions deterministically and publishes updated state.

Views:
- **Chat / Intent Composer:** Structured form for creating intent specs, plus a conversation view.
- **Work Items:** Queue of intent specs with status, progress, and results.
- **Context Assembly:** Selected vs omitted entries with reasoning, budget usage.
- **Diff Review:** Per-hunk approval with visual diff.
- **Provenance Log:** Filterable audit trail of decisions, edits, and approvals.

**Current:** Five webview views use `GenericViewProvider` with a broadcast-based push model. The controller broadcasts typed messages to all views. Views receive updates reactively but there is no per-view state DTO — each view parses the same broadcast events. No model-driven subscription pattern exists.

### 4.2 Approval Flow

**Constitution basis:** § 2.4 (agent boundaries), § 2.8 (user manages outcomes).

**Target:** Two-stage approval:
1. **Intent approval:** User reviews and approves the intent spec before execution begins. No agent executes without an approved intent.
2. **Change approval:** Per-hunk or per-tool-call approval during execution. User accepts or rejects each proposed change.

Both stages record provenance.

**Current:** Intent approval does not exist (no intent specs). Change approval is per-hunk via `EditProposal` / `approveHunk` / `applyApprovedHunks` in `InlineEditFlow`. Tool call approval is handled via `tool.approval_required` events and `respondToApproval`. Both record approval decisions in memory only.

## 5. Data Flow (Target)

```
User creates intent spec via webview
       │
       ▼
Control layer validates and persists intent spec
       │
       ▼
Work scheduler enqueues intent spec
       │
       ▼
When slot available: scheduler produces WorkOrder {
  intentSpec (read-only),
  workspaceSnapshot (read-only),
  context (selected facts + allowed assumptions + relevant decisions),
  sessionConfig (agent mode, budget, permissions)
}
       │
       ▼
Execution layer receives WorkOrder, selects agent adapter
       │
       ▼
Agent adapter connects to provider, runs turn(s)
       │
       ▼
Events stream back through execution layer to control layer
       │
       ├── tool calls → control layer checks permissions → user approval gate → execution
       ├── deltas     → control layer broadcasts to webviews
       └── completion → control layer evaluates acceptance criteria → records provenance
       │
       ▼
Provenance recorder appends log entry
       │
       ▼
Work item marked complete (or failed/cancelled)
```

**Current data flow:**

```
User types prompt in Chat webview
       │
       ▼
controller.handlePrompt(text)
       │
       ▼
Resolve session → assemble context → format prompt → sendTurn to TrueForge
       │
       ▼
Events stream back → broadcast to all webviews
       │
       └── tool.approval_required → user approves/denies → runtime.respondToApproval
```

The current flow has no intent spec, no scheduler queue, no workspace snapshot, no acceptance criteria evaluation, and no provenance recording beyond in-memory undo.

## 6. Storage Layer (Target)

| Store | Purpose | Technology (target) | Current state |
|---|---|---|---|
| App sessions | Session metadata, TrueForge session mapping | SQLite (existing) | SQLite, implemented |
| Intent specs | Structured work items | SQLite (new table) | Not implemented |
| Knowledge entries | Facts, assumptions, inferences, decisions | SQLite (extend `context_blocks`) | SQLite, flat |
| Workspace snapshots | Deterministic point-in-time state | `OPEN — OWNER DECISION REQUIRED` | Not implemented |
| Provenance log | Append-only audit trail | SQLite (new table) | Not implemented (in-memory only) |
| Tool registry | Tool manifests and permissions | `OPEN — OWNER DECISION REQUIRED` | Not implemented (ad-hoc) |
| User config | Provider config, preferences | VS Code settings (existing) | VS Code settings, implemented |

---

## 7. Module Boundaries (Target)

```
src/
  control/                  # Abstraction & Control Layer
    intent/                 # IntentSpec type, validation, persistence
    scheduler/              # Work scheduler, queue, dependency resolution
    workspace/              # WorkspaceSnapshot model
    context/                # ContextManager (fact/assumption/inference/decision)
    provenance/             # ProvenanceRecorder (append-only log)
  execution/                # Execution Layer
    runtime/                # AgentRuntime interface
    adapters/               # Provider adapters (TrueForge, etc.)
    tools/                  # Central ToolRegistry
  user/                     # User-Facing Layer
    webview/                # View providers (existing GenericViewProvider pattern)
    chat/                   # Intent composer / chat
    work-items/             # Work item list view
    context-view/           # Context assembly display
    diff-review/            # Diff review panel
    provenance-log/         # Provenance log viewer
  host/                     # VS Code Extension Host
    extension.ts            # Activation, commands, MCP server
    edits/                  # EditProposal, DiffReview, SafeUndo (existing)
    mcp/                    # MCP server (existing)
  shared/                   # Cross-cutting
    messages.ts             # Typed message contracts (existing)
    types.ts                # Shared types
```

This module structure separates concerns per the Constitution: control is deterministic, execution is free, user is observational.

**Current module structure:** Flat `src/` with `context/`, `edits/`, `mcp/`, `runtime/`, `shared/`, `tools/`, `webview/`. Control and execution are interleaved in `runtime/NotTheLeastController.ts`. No `control/` or `execution/` boundary exists. Intent, scheduler, workspace, and provenance modules are absent.

---

*This architecture document derives from the Product Constitution and does not override it. Where ambiguity exists, the Constitution prevails. All `OPEN` items require owner decision before implementation begins.*