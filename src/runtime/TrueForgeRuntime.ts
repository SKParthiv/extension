import type { TrueForgeApi } from "@truefoundry/trueforge-sdk" with { "resolution-mode": "import" }
import type {
  AgentEvent,
  AgentMode,
  AgentRuntime,
  AgentSession,
  RuntimeConnectionState,
} from "./AgentRuntime"

interface SessionClient {
  create(request: TrueForgeApi.CreateSessionRequest): Promise<{ data: Pick<TrueForgeApi.Session, "id"> }>
  createTurnStream(
    sessionId: string,
    request: TrueForgeApi.CreateTurnSessionsStreamRequest,
  ): Promise<AsyncIterable<TrueForgeApi.TurnStreamingEvent>>
  cancel(sessionId: string): Promise<TrueForgeApi.CancelSessionResponse>
  createTurnEvents?(
    sessionId: string,
    turnId: string,
    request: TrueForgeApi.CreateTurnEventRequest,
  ): Promise<{ data: TrueForgeApi.TurnUserEvent[] }>
}

interface RuntimeClient {
  sessions: SessionClient
}

export interface TrueForgeRuntimeOptions {
  baseUrl: string
  agentName: string
  token?: string
  client?: RuntimeClient
}

export class TrueForgeRuntime implements AgentRuntime {
  private readonly client: RuntimeClient
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private readonly agentName: string
  private lastTurnIdBySession = new Map<string, string>()
  private activeTurns = new Set<string>()
  private knownToolCalls = new Map<string, { id: string; name: string; arguments: Record<string, unknown> | string }>()
  private readonly turnIdByThread = new Map<string, string>()
  private mode: AgentMode = "thinking"
  private connectionState: RuntimeConnectionState = "disconnected"

  public constructor(options: TrueForgeRuntimeOptions) {
    this.agentName = options.agentName
    if (!options.client) {
      throw new Error("Use TrueForgeRuntime.create() when no SDK client is injected.")
    }
    this.client = options.client
  }

  public static async create(options: Omit<TrueForgeRuntimeOptions, "client">): Promise<TrueForgeRuntime> {
    const sdk = await import("@truefoundry/trueforge-sdk")
    const client = new sdk.TrueForge({
      baseUrl: options.baseUrl,
      ...(options.token ? { token: options.token } : {}),
    })
    return new TrueForgeRuntime({ ...options, client })
  }

  public async createSession(): Promise<AgentSession> {
    if (!this.agentName) {
      throw new Error("TrueForge agent name is not configured.")
    }
    try {
      const response = await this.client.sessions.create({
        agent: { name: this.agentName },
      })
      const sessionId = response.data.id
      this.setConnectionState("connected")
      this.emit({ type: "session.created", sessionId })
      return { id: sessionId }
    } catch (error) {
      this.setConnectionState("degraded")
      throw this.reportError(error)
    }
  }

  public async sendTurn(sessionId: string, text: string): Promise<void> {
    await this.consumeTurn(sessionId, {
      input: [{ type: "user.message", content: text }],
    })
  }

  public setMode(mode: AgentMode): void {
    this.mode = mode
    this.emit({ type: "mode.changed", mode })
  }

  public getMode(): AgentMode {
    return this.mode
  }

  public getConnectionState(): RuntimeConnectionState {
    return this.connectionState
  }

  public resetSession(sessionId: string): void {
    if (this.activeTurns.has(sessionId)) {
      throw new Error(`Cannot reset an active session: ${sessionId}`)
    }
    this.lastTurnIdBySession.delete(sessionId)
  }

  public async respondToApproval(
    sessionId: string,
    threadId: string,
    toolCallId: string,
    decision: TrueForgeApi.ApprovalDecision,
  ): Promise<void> {
    if (this.mode !== "tool") {
      throw new Error("Tool approvals are unavailable in Thinking mode.")
    }
    const turnId = this.turnIdByThread.get(threadId)
    if (!turnId) {
      throw new Error(`Cannot approve tool call ${toolCallId}: unknown turn for thread ${threadId}.`)
    }
    if (!this.client.sessions.createTurnEvents) {
      throw new Error("SDK does not support createTurnEvents required for tool approvals.")
    }
    const response = await this.client.sessions.createTurnEvents(sessionId, turnId, {
      events: [
        {
          type: "user.tool_approval" as any,
          threadId,
          toolCallId,
          approval: decision,
        },
      ],
    })
    this.emit({ type: "approval.sent", sessionId, threadId, toolCallId, approved: decision.status === "allow" })
  }

  public async cancel(sessionId: string): Promise<void> {
    await this.client.sessions.cancel(sessionId)
  }

  public onEvent(listener: (event: AgentEvent) => void): { dispose(): void } {
    this.listeners.add(listener)
    return {
      dispose: () => this.listeners.delete(listener),
    }
  }

  private async consumeTurn(
    sessionId: string,
    request: TrueForgeApi.CreateTurnSessionsStreamRequest,
  ): Promise<void> {
    if (this.activeTurns.has(sessionId)) {
      throw new Error(`A turn is already running for session: ${sessionId}`)
    }
    this.activeTurns.add(sessionId)
    try {
      const previousTurnId = this.lastTurnIdBySession.get(sessionId)
      const response = await this.client.sessions.createTurnStream(sessionId, {
        ...request,
        ...(previousTurnId ? { previousTurnId } : {}),
      })
      this.setConnectionState("connected")

      for await (const event of response) {
        this.mapEvent(sessionId, event)
      }
    } catch (error) {
      this.setConnectionState("degraded")
      throw this.reportError(error)
    } finally {
      this.activeTurns.delete(sessionId)
    }
  }

  private mapEvent(sessionId: string, event: TrueForgeApi.TurnStreamingEvent): void {
    switch (event.type) {
      case "turn.created":
        this.lastTurnIdBySession.set(sessionId, event.turnId)
        if (event.threadId) {
          this.turnIdByThread.set(event.threadId, event.turnId)
        }
        return
      case "model.message.delta":
        if (event.content || event.reasoningContent) {
          this.emit({
            type: "model.message.delta",
            text: event.content ?? "",
            ...(event.reasoningContent ? { reasoning: event.reasoningContent } : {}),
            sessionId,
          })
        }
        if (event.usage) {
          this.emitUsage(event.usage, sessionId)
        }
        return
      case "model.message":
        if (event.toolCalls) {
          for (const tc of event.toolCalls) {
            let parsedArgs: Record<string, unknown> | string = tc.function.arguments
            try {
              parsedArgs = JSON.parse(tc.function.arguments)
            } catch {}
            this.knownToolCalls.set(tc.id, {
              id: tc.id,
              name: tc.function.name,
              arguments: parsedArgs,
            })
          }
        }
        this.emit({
          type: "model.message",
          text: contentToText(event.content),
          ...(event.reasoningContent ? { reasoning: event.reasoningContent } : {}),
          sessionId,
        })
        if (event.usage) {
          this.emitUsage(event.usage, sessionId)
        }
        return
      case "tool.approval_required": {
        const enriched = event.toolCalls.map((tc) => {
          const info = this.knownToolCalls.get(tc.id)
          return {
            id: tc.id,
            sourceEventId: tc.sourceEventId,
            toolName: info?.name,
            arguments: info?.arguments,
          }
        })
        this.emit({
          type: "tool.approval_required",
          threadId: event.threadId,
          toolCalls: enriched,
          sessionId,
        })
        return
      }
      case "tool.response_required": {
        const enriched = event.toolCalls.map((tc) => {
          const info = this.knownToolCalls.get(tc.id)
          return {
            id: tc.id,
            sourceEventId: tc.sourceEventId,
            toolName: info?.name,
            arguments: info?.arguments,
          }
        })
        this.emit({
          type: "tool.response_required",
          threadId: event.threadId,
          toolCalls: enriched,
          sessionId,
        })
        return
      }
      case "turn.done":
        this.emit({ type: "turn.done", state: event.state, sessionId })
        return
      default:
        return
    }
  }

  private emitUsage(usage: TrueForgeApi.ModelMessageUsage, sessionId?: string): void {
    this.emit({
      type: "usage",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      sessionId,
    })
  }

  private setConnectionState(state: RuntimeConnectionState): void {
    if (this.connectionState === state) {
      return
    }
    this.connectionState = state
    this.emit({ type: "connection.changed", state })
  }

  private reportError(error: unknown): Error {
    const reported = error instanceof Error ? error : new Error(String(error))
    this.emit({ type: "error", message: reported.message })
    return reported
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

function contentToText(content: TrueForgeApi.ModelMessageEventContent | null | undefined): string {
  if (!content) {
    return ""
  }
  if (typeof content === "string") {
    return content
  }
  return content
    .map((part) => ("text" in part ? part.text : ""))
    .join("")
}
