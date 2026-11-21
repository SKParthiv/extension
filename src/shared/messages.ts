export interface WebviewToolApprovalCall {
  id: string
  sourceEventId: string
  toolName?: string
  arguments?: Record<string, unknown> | string
}

export type WebviewToExtensionMessage =
  | { type: "ready" }
  | { type: "openPanel" }
  | { type: "inlineEditRequest"; instruction: string }
  | { type: "sendPrompt"; text: string }
  | { type: "cancelTurn" }
  | { type: "setMode"; mode: "thinking" | "tool" }
  | { type: "toolApproval"; threadId: string; toolCallId: string; decision: "allow" | "deny" }
  | { type: "reviewDiff"; proposalId: string; hunkId?: string }
  | { type: "contextAction"; action: "store" | "attach" | "move" | "copy"; blockId: string; destinationSessionId?: string }
  | { type: "selectSession"; sessionId: string }

export type ExtensionToWebviewMessage =
  | { type: "runtimeStatus"; status: "disconnected" | "idle" | "running" }
  | { type: "runtimeConnection"; state: "disconnected" | "connected" | "degraded" }
  | { type: "userMessage"; text: string }
  | { type: "assistantDelta"; text: string }
  | { type: "assistantMessage"; text: string }
  | { type: "sessionChanged"; sessionId: string }
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
  | { type: "error"; message: string }
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
