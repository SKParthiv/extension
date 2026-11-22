/**
 * @file
 * Message contracts shared between the VS Code extension host (Node) and
 * the React webview (browser). These types are the serialization boundary
 * for the two-process extension architecture.
 *
 * == Data flow ==
 *
 * Webview → Extension:  {@link WebviewToExtensionMessage}  (user actions)
 * Extension → Webview:  {@link ExtensionToWebviewMessage}  (state updates)
 *
 * Owned by: NotTheLeastController (sends) / webview/index.tsx (receives).
 * No circular imports; depends only on primitives and other types in this file.
 */

/**
 * A tool call sent to the webview for user approval.
 * `toolName` and `arguments` are enriched by TrueForgeRuntime from the
 * preceding `model.message` event's toolCalls array.
 */
export interface WebviewToolApprovalCall {
  id: string
  sourceEventId: string
  toolName?: string
  arguments?: Record<string, unknown> | string
}

/** Normalised terminal status extracted from a `turn.done` event. */
export type TerminalStatus = "done" | "cancelled" | "error"

/** Final output extracted from a `turn.done` event whose output is a model message. */
export interface TurnFinalOutput {
  text: string
  reasoning?: string
  messageId?: string
  createdAt?: string
}

/**
 * Summary of a completed turn, forwarded to the webview so it can
 * show terminal-state metadata without parsing raw SDK events.
 */
export interface TerminalEventReport {
  terminalStatus: TerminalStatus
  terminalError?: string
  terminalOutputPresent: boolean
  terminalOutputLength?: number
  metrics?: { inputTokens?: number; outputTokens?: number }
}

/**
 * Lifecycle stage of the current (or most recent) agent request.
 * Stages are monotonic — the controller advances through them as the
 * runtime responds to the prompt.
 */
export type RequestStage =
  | "idle"
  | "prompt.submitted"
  | "resolving.session"
  | "assembling.context"
  | "sending.request"
  | "waiting.first_event"
  | "waiting.model"
  | "model.generating"
  | "tool.requested"
  | "awaiting.approval"
  | "tool.executing"
  | "waiting.tool_result"
  | "model.resuming"
  | "finalizing"
  | "completed"
  | "cancelled"
  | "failed"

/**
 * High-resolution timestamps recorded throughout one request lifecycle.
 * Durations are computed lazily by {@link SharedRuntimeState.recordTiming}
 * when both start and end timestamps are present.
 */
export interface RequestTiming {
  submittedAt?: number
  sessionResolvedAt?: number
  contextAssembledAt?: number
  requestDispatchedAt?: number
  firstEventAt?: number
  firstDeltaAt?: number
  firstVisibleTextAt?: number
  toolRequestedAt?: number
  approvalRespondedAt?: number
  toolExecutionStartedAt?: number
  toolExecutionEndedAt?: number
  finalMessageAt?: number
  completedAt?: number
  totalDuration?: number
  timeToFirstEvent?: number
  timeToFirstToken?: number
  toolExecutionDuration?: number
  approvalWaitingDuration?: number
  modelGenerationDuration?: number
}

/**
 * Messages sent **from the webview** to the extension host.
 * Each variant maps to a specific user action in the React UI.
 */
export type WebviewToExtensionMessage =
  /** Webview is mounted and ready to receive state snapshots. */
  | { type: "ready"; viewId: string }
  /** User clicked "Open panel" — reveal the TrueForge view container. */
  | { type: "openPanel" }
  /** User requested an inline edit on the active selection. */
  | { type: "inlineEditRequest"; instruction: string }
  /** User submitted a chat prompt, optionally with attached files or symbols. */
  | { type: "sendPrompt"; text: string; attachments?: Array<{ type: "file" | "symbol"; path: string; label: string; startLine?: number; endLine?: number }> }
  /** User cancelled the current turn. */
  | { type: "cancelTurn" }
  /** User switched between Thinking (read-only) and Tool (approval-gated) mode. */
  | { type: "setMode"; mode: "thinking" | "tool" }
  /** User approved or denied a tool call. */
  | { type: "toolApproval"; threadId: string; toolCallId: string; decision: "allow" | "deny" }
  /** User wants to review a diff for a specific proposal / hunk. */
  | { type: "reviewDiff"; proposalId: string; hunkId?: string }
  /** User performed a context management action (store / attach / move / copy). */
  | { type: "contextAction"; action: "store" | "attach" | "move" | "copy"; blockId: string; destinationSessionId?: string }
  /** User selected a different session from the sidebar. */
  | { type: "selectSession"; sessionId: string }
  /** User typed a query to resolve a file or symbol for attachment. */
  | { type: "resolveAttachment"; query: string }
  /** User requested a diagnostics report export. */
  | { type: "exportDiagnostics" }

/**
 * Tracks one tool call through its lifecycle from request to completion.
 * Stored in {@link SharedRuntimeState} and forwarded to the webview
 * as {@link ExtensionToWebviewMessage} `"toolExecutionUpdate"`.
 */
export interface ToolExecutionInfo {
  id: string
  toolName: string
  arguments: Record<string, unknown> | string
  state: "requested" | "approved" | "denied" | "executing" | "completed" | "failed"
  requestedAt: number
  approvedAt?: number
  executedAt?: number
  completedAt?: number
  result?: string
  error?: string
  duration?: number
}

/**
 * One entry in the activity log shown in the webview's Activity view.
 * The log is LRU-capped at 200 entries in {@link SharedRuntimeState}.
 */
export interface ActivityEntry {
  id: string
  type: "event" | "stage_change" | "tool" | "approval" | "error" | "info"
  timestamp: number
  title: string
  description?: string
  sessionId?: string
  turnId?: string
  requestId?: string
}

/**
 * An assistant message with a stable identity for delta-merge deduplication.
 * When {@link ExtensionToWebviewMessage} `"assistantDelta"` events arrive,
 * the webview appends text to the last entry with the same `messageId`.
 */
export interface AssistantMessageEntry {
  role: "assistant"
  text: string
  reasoning?: string
  /** SDK `model.message.id` — stable across delta events. */
  messageId?: string
  threadId?: string
  createdAt?: string
}

/**
 * Messages sent **from the extension host** to the webview.
 * These are the only way the controller pushes state, events, and
 * errors to the React UI.
 */
export type ExtensionToWebviewMessage =
  /** A new request has started; the controller assigns a requestId for correlation. */
  | { type: "requestStarted"; requestId: string; sessionId?: string }
  /** The runtime connection status changed (disconnected / idle / running). */
  | { type: "runtimeStatus"; status: "disconnected" | "idle" | "running" }
  /** The TrueForge agent connection state. */
  | { type: "runtimeConnection"; state: "disconnected" | "connected" | "degraded" }
  /** The user's prompt echoed back so the chat view can render it. */
  | { type: "userMessage"; text: string; attachments?: Array<{ type: "file" | "symbol"; path: string; label: string }>; timestamp?: number }
  /** Streaming delta from an in-progress assistant reply. The webview appends `text` to the last assistant bubble. */
  | { type: "assistantDelta"; text: string; reasoning?: string; messageId?: string; threadId?: string; sessionId?: string }
  /** A complete assistant message (replaces any in-progress delta for this messageId). */
  | { type: "assistantMessage"; text: string; reasoning?: string; messageId?: string; threadId?: string; createdAt?: string; sessionId?: string }
  /** Final assistant output extracted from a `turn.done` event — used for deduplicated display. */
  | { type: "assistantFinalMessage"; text: string; reasoning?: string; messageId?: string; threadId?: string }
  /** The active session changed (user switched sessions). */
  | { type: "sessionChanged"; sessionId: string }
  /** The request stage changed (see {@link RequestStage}). */
  | { type: "stageChanged"; stage: RequestStage }
  /** Performance timing update for the current request. */
  | { type: "timing"; timing: RequestTiming }
  /** The controller assigned a requestId for correlation. */
  | { type: "requestId"; requestId: string }
  /** No recent activity; forwarded so the UI can show an idle warning. */
  | { type: "inactivityWarning"; elapsedSeconds: number }
  /** Context assembly result — which blocks were selected / omitted / retrieved for the prompt. */
  | {
      type: "contextAssembly"
      budget: number
      usedTokens: number
      selected: Array<{ title: string; tokenEstimate: number; reason: "pinned" | "priority" | "position" | "attachment" }>
      omitted: Array<{ title: string; tokenEstimate: number; reason: "budget" }>
      retrieved: Array<{ path: string; startLine: number; endLine: number; reason: string }>
    }
  /** One or more tool calls require user approval before execution. */
  | {
      type: "toolApprovalRequired"
      threadId: string
      sessionId?: string
      toolCalls: WebviewToolApprovalCall[]
    }
  /** An error occurred (runtime, session, approval, or general). */
  | { type: "error"; message: string; sessionId?: string }
  /** Full state snapshot of all sessions, blocks, library entries and conflicts. */
  | {
      type: "contextSnapshot"
      activeSessionId: string
      sessions: Array<{ id: string; title: string }>
      blocks: Array<{
        id: string
        title: string
        content: string
        sourceType: string
        scope: "task" | "project" | "global"
        priority: "P0" | "P1" | "P2" | "P3" | null
        status: "inbox" | "active" | "deferred" | "archived" | "excluded" | "resolved"
        position: number
        pinned: boolean
        locked: boolean
        tokenEstimate: number
      }>
      library: Array<{ id: string; title: string; visibility: "global" | "project" }>
      conflicts: Array<{ key: string; leftTitle: string; rightTitle: string }>
    }
  /** New activity log entry. */
  | { type: "activityUpdate"; sessionId?: string; entry: ActivityEntry }
  /** Tool execution state changed (requested → approved → completed / failed). */
  | { type: "toolExecutionUpdate"; tool: ToolExecutionInfo }
  /** Telemetry snapshot (tokens, GPU, timing, errors, counts). */
  | { type: "telemetryUpdate"; data: TelemetryData }
  /** Diagnostics data for the report export panel. */
  | { type: "diagnosticsUpdate"; data: DiagnosticsData }
  /** Results from a file / symbol attachment query. */
  | { type: "attachmentResolved"; query: string; results: Array<{ type: "file" | "symbol"; path: string; label: string; startLine?: number; endLine?: number }> }
  /** Terminal event summary from a completed / failed / cancelled turn. */
  | { type: "terminalEventReport"; report: TerminalEventReport; requestId?: string; turnId?: string }
  /** Turn is paused waiting for approval, auth or a tool response. */
  | { type: "turnPaused"; status: "paused" | "waiting_approval" | "waiting_response" | "waiting_auth"; threadId?: string; reason?: string; requestId?: string; turnId?: string }
  /** Request was cancelled (by user, by runtime, or by timeout). */
  | { type: "requestCancelled"; reason: string; partialOutputPresent?: boolean; partialOutputLength?: number; requestId?: string; turnId?: string }
  /** Request completed successfully. */
  | { type: "requestCompleted"; requestId?: string; turnId?: string; outputPresent?: boolean; outputLength?: number }
  /** Request failed with an error message. */
  | { type: "requestFailed"; requestId?: string; turnId?: string; errorMessage: string }
  /** Request was interrupted; may require recovery before continuing. */
  | { type: "requestInterrupted"; requestId?: string; recoveryRequired?: boolean }

/**
 * Aggregate telemetry snapshot pushed to the webview after every state change.
 * Combines connection state, token usage, timing, GPU metrics, and request counts.
 */
export interface TelemetryData {
  connectionState: "disconnected" | "connected" | "degraded"
  agentAvailable: boolean
  activeSessionId?: string
  activeTurnId?: string
  activeRequestId?: string
  currentStage: RequestStage
  modelName?: string
  /** Total input tokens across all calls (estimated + reported). */
  inputTokens?: number
  /** Total output tokens across all calls (estimated + reported). */
  outputTokens?: number
  /** Input tokens confirmed by the SDK (may be a subset of `inputTokens`). */
  reportedInputTokens?: number
  /** Output tokens confirmed by the SDK (may be a subset of `outputTokens`). */
  reportedOutputTokens?: number
  estimatedInputTokens?: number
  estimatedOutputTokens?: number
  /** Cumulative error count for this session. */
  errors: number
  /** Cumulative request count for this session. */
  requestCount: number
  gpuName?: string
  gpuUtilization?: number
  gpuMemoryUsed?: number
  gpuMemoryTotal?: number
  gpuTemperature?: number
  /** Seconds since the current request was submitted. */
  elapsedSeconds?: number
  /** Timestamp of the last agent event (used for inactivity detection). */
  lastEventTimestamp?: number
  /** Seconds since the last agent event. */
  inactivityElapsed?: number
}

/** Wrapper for the in-memory diagnostic event ring buffer. */
export interface DiagnosticsData {
  events: DiagnosticEvent[]
}

/**
 * One entry in the diagnostic event ring buffer (max 500 events).
 * Logged by {@link NotTheLeastLogger} for export to the webview.
 */
export interface DiagnosticEvent {
  id: string
  timestamp: string
  component: string
  eventName: string
  requestId?: string
  sessionId?: string
  turnId?: string
  toolCallId?: string
  duration?: number
  level: "debug" | "info" | "warn" | "error"
  message: string
  details?: string
}
