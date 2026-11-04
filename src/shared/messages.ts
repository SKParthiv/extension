export type WebviewToExtensionMessage =
  | { type: "ready" }
  | { type: "openPanel" }
  | { type: "inlineEditRequest"; instruction: string }
  | { type: "contextAction"; action: "store" | "attach" | "move" | "copy"; blockId: string; destinationSessionId?: string }
  | { type: "selectSession"; sessionId: string }

export type ExtensionToWebviewMessage =
  | { type: "runtimeStatus"; status: "disconnected" | "idle" | "running" }
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
