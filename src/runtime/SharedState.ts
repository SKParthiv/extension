import { EventEmitter } from "node:events"
import type { AgentMode, RuntimeConnectionState } from "./AgentRuntime"
import type { RequestStage, RequestTiming, TelemetryData, ActivityEntry, ToolExecutionInfo } from "../shared/messages"

export class SharedRuntimeState {
  private readonly emitter = new EventEmitter()
  private _connectionState: RuntimeConnectionState = "disconnected"
  private _mode: AgentMode = "thinking"
  private _activeSessionId?: string
  private _activeTurnId?: string
  private _activeRequestId?: string
  private _currentStage: RequestStage = "idle"
  private _running = false
  private _timing: RequestTiming = {}
  private readonly _activities: ActivityEntry[] = []
  private readonly _toolExecutions: ToolExecutionInfo[] = []
  private _inputTokens = 0
  private _outputTokens = 0
  private _reportedInputTokens = 0
  private _reportedOutputTokens = 0
  private _errorCount = 0
  private _requestCount = 0
  private _lastEventTimestamp = 0
  private _modelName?: string

  public onDidChangeState(listener: () => void): { dispose(): void } { this.emitter.on("state", listener); return { dispose: () => { this.emitter.off("state", listener) } } }
  private emitState(): void { this.emitter.emit("state") }

  public get connectionState() { return this._connectionState }
  public get mode() { return this._mode }
  public get activeSessionId() { return this._activeSessionId }
  public get activeTurnId() { return this._activeTurnId }
  public get activeRequestId() { return this._activeRequestId }
  public get currentStage() { return this._currentStage }
  public get running() { return this._running }
  public get timing() { return { ...this._timing } }
  public get activities() { return this._activities }
  public get toolExecutions() { return this._toolExecutions }
  public get modelName() { return this._modelName }

  public setConnectionState(state: RuntimeConnectionState): void {
    if (this._connectionState === state) return; this._connectionState = state
    this.recordActivity("info", "Connection: " + state); this.emitState()
  }
  public setMode(mode: AgentMode): void {
    if (this._mode === mode) return; this._mode = mode
    this.recordActivity("info", "Mode: " + mode); this.emitState()
  }
  public setActiveSession(s: string | undefined): void { this._activeSessionId = s; this.emitState() }
  public setActiveTurn(t: string | undefined): void { this._activeTurnId = t; this.emitState() }
  public setActiveRequestId(r: string | undefined): void { this._activeRequestId = r; this.emitState() }

  public setStage(stage: RequestStage): void {
    this._currentStage = stage
    this._running = stage !== "idle" && stage !== "completed" && stage !== "cancelled" && stage !== "failed"
    this.recordActivity("stage_change", "Stage: " + stage); this.emitState()
  }
  public setModelName(n: string | undefined): void { this._modelName = n; this.emitState() }

  public recordTiming(update: Partial<RequestTiming>): void {
    Object.assign(this._timing, update)
    const t = this._timing
    if (t.submittedAt && t.completedAt) t.totalDuration = t.completedAt - t.submittedAt
    if (t.submittedAt && t.firstEventAt) t.timeToFirstEvent = t.firstEventAt - t.submittedAt
    if (t.submittedAt && t.firstDeltaAt) t.timeToFirstToken = t.firstDeltaAt - t.submittedAt
    if (t.toolExecutionStartedAt && t.toolExecutionEndedAt) t.toolExecutionDuration = t.toolExecutionEndedAt - t.toolExecutionStartedAt
    if (t.approvalRespondedAt && t.toolRequestedAt) t.approvalWaitingDuration = t.approvalRespondedAt - t.toolRequestedAt
    this.emitState()
  }

  public recordUsage(i: number, o: number, r: boolean): void {
    this._inputTokens += i; this._outputTokens += o
    if (r) { this._reportedInputTokens += i; this._reportedOutputTokens += o }
    this.emitState()
  }


public incrementRequestCount(): void { this._requestCount++; this.emitState() }
public incrementErrorCount(): void { this._errorCount++; this.emitState() }
public setLastEventTimestamp(ts: number): void { this._lastEventTimestamp = ts; this.emitState() }

public recordActivity(type: ActivityEntry["type"], title: string, description?: string, extra?: { sessionId?: string; turnId?: string; requestId?: string }): ActivityEntry {
  const entry: ActivityEntry = {
    id: "act-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    type, timestamp: Date.now(), title,
    description: description ? String(description).slice(0, 500) : undefined,
    ...extra,
  }
  this._activities.push(entry)
  while (this._activities.length > 200) this._activities.shift()
  this.emitState()
  return entry
}

public recordToolExecution(tool: ToolExecutionInfo): void {
  const idx = this._toolExecutions.findIndex((t) => t.id === tool.id)
  if (idx >= 0) this._toolExecutions[idx] = { ...this._toolExecutions[idx], ...tool }
  else this._toolExecutions.push(tool)
  while (this._toolExecutions.length > 100) this._toolExecutions.shift()
  this.emitState()
}

public resetRequest(): void {
  this._activeRequestId = undefined; this._activeTurnId = undefined
  this._timing = {}; this._currentStage = "idle"; this._running = false
  this.emitState()
}

public getTelemetryData(): TelemetryData {
  return {
    connectionState: this._connectionState,
    agentAvailable: this._connectionState === "connected",
    activeSessionId: this._activeSessionId,
    activeTurnId: this._activeTurnId,
    activeRequestId: this._activeRequestId,
    currentStage: this._currentStage,
    modelName: this._modelName,
    inputTokens: this._inputTokens,
    outputTokens: this._outputTokens,
    reportedInputTokens: this._reportedInputTokens,
    reportedOutputTokens: this._reportedOutputTokens,
    errors: this._errorCount,
    requestCount: this._requestCount,
    elapsedSeconds: this._timing.submittedAt ? Math.round((Date.now() - this._timing.submittedAt) / 1000) : 0,
    lastEventTimestamp: this._lastEventTimestamp || undefined,
    inactivityElapsed: this._lastEventTimestamp ? Math.round((Date.now() - this._lastEventTimestamp) / 1000) : undefined,
  }
}
}