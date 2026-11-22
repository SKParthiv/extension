export interface WebviewToolApprovalCall {
  id: string
  sourceEventId: string
  toolName?: string
  arguments?: Record<string, unknown> | string
}

/** Normalized terminal status seen by the UI. */
export type TerminalStatus = "done" | "cancelled" | "error"

/** Final output extracted from a turn.done event. */
export interface TurnFinalOutput {
  text: string
  reasoning?: string
  messageId?: string
  createdAt?: string
}

export interface TerminalEventReport {
  terminalStatus: TerminalStatus
  terminalError?: string
  terminalOutputPresent: boolean
  terminalOutputLength?: number
  metrics?: { inputTokens?: number; outputTokens?: number }
}

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

export type WebviewToExtensionMessage =
  | { type: "ready"; viewId: string }
  | { type: "openPanel" }
  | { type: "inlineEditRequest"; instruction: string }
  | { type: "sendPrompt"; text: string; attachments?: Array<{ type: "file" | "symbol"; path: string; label: string; startLine?: number; endLine?: number }> }
  | { type: "cancelTurn" }
  | { type: "setMode"; mode: "thinking" | "tool" }
  | { type: "toolApproval"; threadId: string; toolCallId: string; decision: "allow" | "deny" }
  | { type: "reviewDiff"; proposalId: string; hunkId?: string }
  | { type: "contextAction"; action: "store" | "attach" | "move" | "copy"; blockId: string; destinationSessionId?: string }
  | { type: "selectSession"; sessionId: string }
  | { type: "resolveAttachment"; query: string }
  | { type: "exportDiagnostics" }

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

/** An assistant message with stable identity for delta-merge deduplication. */
export interface AssistantMessageEntry {
  role: "assistant"
  text: string
  reasoning?: string
  messageId?: string       // SDK model.message.id
  threadId?: string
  createdAt?: string
}

export type ExtensionToWebviewMessage =
  | { type: "requestStarted"; requestId: string; sessionId?: string }
  | { type: "runtimeStatus"; status: "disconnected" | "idle" | "running" }
  | { type: "runtimeConnection"; state: "disconnected" | "connected" | "degraded" }
  | { type: "userMessage"; text: string; attachments?: Array<{ type: "file" | "symbol"; path: string; label: string }>; timestamp?: number }
  | { type: "assistantDelta"; text: string; reasoning?: string; messageId?: string; threadId?: string }
  | { type: "assistantMessage"; text: string; reasoning?: string; messageId?: string; threadId?: string; createdAt?: string }
  | { type: "assistantFinalMessage"; text: string; reasoning?: string; messageId?: string; threadId?: string }
  | { type: "sessionChanged"; sessionId: string }
  | { type: "stageChanged"; stage: RequestStage }
  | { type: "timing"; timing: RequestTiming }
  | { type: "requestId"; requestId: string }
  | { type: "inactivityWarning"; elapsedSeconds: number }
  | {
      type: "contextAssembly"
      budget: number
      usedTokens: number
      selected: Array<{ title: string; tokenEstimate: number; reason: "pinned" | "priority" | "position" }>
      omitted: Array<{ title: string; tokenEstimate: number; reason: "budget" }>
      retrieved: Array<{ path: string; startLine: number; endLine: number; reason: string }>
    }
  | {
      type: "toolApprovalRequired"
      threadId: string
      sessionId?: string
      toolCalls: WebviewToolApprovalCall[]
    }
  | { type: "error"; message: string; sessionId?: string }
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
  | { type: "activityUpdate"; sessionId?: string; entry: ActivityEntry }
  | { type: "toolExecutionUpdate"; tool: ToolExecutionInfo }
  | { type: "telemetryUpdate"; data: TelemetryData }
  | { type: "diagnosticsUpdate"; data: DiagnosticsData }
  | { type: "attachmentResolved"; query: string; results: Array<{ type: "file" | "symbol"; path: string; label: string; startLine?: number; endLine?: number }> }
  | { type: "terminalEventReport"; report: TerminalEventReport; requestId?: string; turnId?: string }
  | { type: "turnPaused"; status: "paused" | "waiting_approval" | "waiting_response" | "waiting_auth"; threadId?: string; reason?: string; requestId?: string; turnId?: string }
  | { type: "requestCancelled"; reason: string; partialOutputPresent?: boolean; partialOutputLength?: number; requestId?: string; turnId?: string }
  | { type: "requestCompleted"; requestId?: string; turnId?: string; outputPresent?: boolean; outputLength?: number }
  | { type: "requestFailed"; requestId?: string; turnId?: string; errorMessage: string }
  | { type: "requestInterrupted"; requestId?: string; recoveryRequired?: boolean }

export interface TelemetryData {
  connectionState: "disconnected" | "connected" | "degraded"
  agentAvailable: boolean
  activeSessionId?: string
  activeTurnId?: string
  activeRequestId?: string
  currentStage: RequestStage
  modelName?: string
  inputTokens?: number
  outputTokens?: number
  reportedInputTokens?: number
  reportedOutputTokens?: number
  estimatedInputTokens?: number
  estimatedOutputTokens?: number
  errors: number
  requestCount: number
  gpuName?: string
  gpuUtilization?: number
  gpuMemoryUsed?: number
  gpuMemoryTotal?: number
  gpuTemperature?: number
  elapsedSeconds?: number
  lastEventTimestamp?: number
  inactivityElapsed?: number
}

export interface DiagnosticsData {
  events: DiagnosticEvent[]
}

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
