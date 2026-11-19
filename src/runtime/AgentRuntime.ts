import type { TrueForgeApi } from "@truefoundry/trueforge-sdk" with { "resolution-mode": "import" }

export interface AgentSession {
  id: string
}

export type AgentMode = "thinking" | "tool"
export type RuntimeConnectionState = "disconnected" | "connected" | "degraded"

export interface EnrichedToolCall {
  id: string
  sourceEventId: string
  toolName?: string
  arguments?: Record<string, unknown> | string
}

export type AgentEvent =
  | { type: "session.created"; sessionId: string }
  | { type: "mode.changed"; mode: AgentMode }
  | { type: "model.message.delta"; text: string; reasoning?: string; sessionId?: string }
  | { type: "model.message"; text: string; reasoning?: string; sessionId?: string }
  | { type: "tool.approval_required"; threadId: string; toolCalls: EnrichedToolCall[]; sessionId?: string }
  | { type: "tool.response_required"; threadId: string; toolCalls: EnrichedToolCall[]; sessionId?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; sessionId?: string }
  | { type: "turn.done"; state: TrueForgeApi.TurnDoneEventState; sessionId?: string }
  | { type: "connection.changed"; state: RuntimeConnectionState; sessionId?: string }
  | { type: "error"; message: string; sessionId?: string }

export interface AgentRuntime {
  createSession(): Promise<AgentSession>
  sendTurn(sessionId: string, text: string): Promise<void>
  setMode(mode: AgentMode): void
  getMode(): AgentMode
  getConnectionState(): RuntimeConnectionState
  resetSession(sessionId: string): void
  cancel(sessionId: string): Promise<void>
  respondToApproval(
    sessionId: string,
    threadId: string,
    toolCallId: string,
    decision: TrueForgeApi.ApprovalDecision,
  ): Promise<void>
  onEvent(listener: (event: AgentEvent) => void): { dispose(): void }
}
