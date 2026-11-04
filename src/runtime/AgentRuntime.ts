import type { TrueForgeApi } from "@truefoundry/trueforge-sdk" with { "resolution-mode": "import" }

export interface AgentSession {
  id: string
}

export type AgentMode = "thinking" | "tool"
export type RuntimeConnectionState = "disconnected" | "connected" | "degraded"

export type AgentEvent =
  | { type: "session.created"; sessionId: string }
  | { type: "mode.changed"; mode: AgentMode }
  | { type: "model.message.delta"; text: string; reasoning?: string }
  | { type: "model.message"; text: string; reasoning?: string }
  | { type: "tool.approval_required"; threadId: string; toolCalls: TrueForgeApi.ToolCallRef[] }
  | { type: "tool.response_required"; threadId: string; toolCalls: TrueForgeApi.ToolCallRef[] }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turn.done"; state: TrueForgeApi.TurnDoneEventState }
  | { type: "connection.changed"; state: RuntimeConnectionState }
  | { type: "error"; message: string }

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
