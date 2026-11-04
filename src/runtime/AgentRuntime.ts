import type { ExtensionToWebviewMessage } from "../shared/messages"

export interface AgentSession {
  id: string
}

export interface AgentRuntime {
  createSession(): Promise<AgentSession>
  sendTurn(sessionId: string, text: string): Promise<void>
  cancel(sessionId: string): Promise<void>
  onEvent(listener: (event: ExtensionToWebviewMessage) => void): { dispose(): void }
}

