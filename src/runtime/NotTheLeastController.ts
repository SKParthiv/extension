/**
 * @file
 * Central orchestrator for the VS Code extension side of NotTheLeast.
 * Owns the TrueForge runtime connection, shared state, context database,
 * GPU telemetry polling, and all webview message broadcasts.
 *
 * == Responsibilities ==
 *
 * 1. Lifecycle — initialise the context database, GPU poller and
 *    TrueForge runtime on extension activation.
 * 2. Session management — map application-level session IDs to
 *    TrueForge runtime session IDs.
 * 3. Prompt dispatch — assemble context, then send the prompt via
 *    the runtime, letting events flow back through onRuntimeEvent.
 * 4. Approval routing — store pending tool approval requests and
 *    forward user decisions back to the runtime.
 * 5. Broadcast — push every state change and runtime event to all
 *    registered webview views via setBroadcast / _broadcast.
 *
 * Owned by: extension.ts (created in activate, disposed in deactivate).
 */

import * as vscode from "vscode"
import { randomUUID } from "node:crypto"
import { TrueForgeRuntime } from "./TrueForgeRuntime"
import type { AgentEvent } from "./AgentRuntime"
import { SharedRuntimeState } from "./SharedState"
import { logInfo, logWarn, logError, exportDiagnosticsJson } from "./NotTheLeastLogger"
import { readGpuTelemetry } from "./GpuTelemetry"
import { assembleContext } from "../context/ContextAssembler"
import type { ContextCandidate } from "../context/ContextSelector"
import { ContextService } from "../context/ContextService"
import { ContextDatabase } from "../context/db/Database"
import { detectConflicts } from "../context/ContextConflicts"
import type { ExtensionToWebviewMessage } from "../shared/messages"

export class NotTheLeastController {
  /** Ephemeral reactive state shared with the webview via broadcasts. */
  public readonly state = new SharedRuntimeState()
  private runtime?: TrueForgeRuntime
  private runtimeInitialized = false
  private runtimeInitPromise?: Promise<void>
  private disposables: vscode.Disposable[] = []
  private database?: ContextDatabase
  private service?: ContextService
  /**
   * Maps application-level session IDs (prefixed "s-") to TrueForge
   * runtime session IDs. Application IDs are created client-side so the
   * UI can switch sessions without waiting for the runtime.
   */
  private readonly runtimeSessionIds = new Map<string, string>()
  /**
   * Tool approval requests waiting for a user decision.
   * Key = `${threadId}:${toolCallId}`.
   */
  private readonly pendingApprovals = new Map<string, { appSessionId: string; runtimeSessionId: string; threadId: string; toolCallId: string }>()
  /** The application-level session ID that is currently active. */
  private activeSessionId?: string
  /**
   * App-session ID being created but not yet fully initialized.
   * Set before the runtime session is created, cleared on full initialization.
   * If runtime creation fails, a retry reuses this same ID.
   */
  private pendingAppSessionId?: string
  /**
   * Runtime session ID that has been created but whose mapping (app -> runtime)
   * has not yet been persisted to the database. Set after runtime creation,
   * cleared after mapping persistence. If mapping persistence fails, a retry
   * skips runtime creation and only retries the mapping.
   */
  private pendingRuntimeSessionId?: string
  private gpuPollTimer?: ReturnType<typeof setInterval>
  /** Cached result of the most recent context assembly, used for snapshot restoration. */
  private lastContextAssembly?: Record<string, unknown>

  /**
   * Registry of connected webview views keyed by viewId.
   * Each entry stores a `postMessage` callback and a unique
   * per-view registration ID used for stale-disposal protection.
   */
  private readonly viewRegistry = new Map<string, { postMessage: (msg: Record<string, unknown>) => void; regId: number }>()
  /**
   * Per-viewId monotonic counters for stale-disposal protection.
   */
  private readonly viewRegCounters = new Map<string, number>()

  /**
   * Register a webview with the controller. Returns a disposable
   * that unregisters the view when called. Uses a per-viewId
   * monotonic registration ID so stale disposals never remove a
   * newer registration for the same viewId.
   */
  public registerView(
    viewId: string,
    postMessage: (msg: Record<string, unknown>) => void,
  ): vscode.Disposable {
    const regId = (this.viewRegCounters.get(viewId) ?? 0) + 1
    this.viewRegCounters.set(viewId, regId)
    this.viewRegistry.set(viewId, { postMessage, regId })
    void this.ensureRuntime()
    return {
      dispose: () => {
        const current = this.viewRegistry.get(viewId)
        if (current && current.regId === regId) {
          this.viewRegistry.delete(viewId)
        }
      },
    }
  }

  /**
   * Broadcast a message to every registered webview.
   * Each view gets its own copy (same reference, but webview.postMessage
   * serializes it independently).
   */
  private broadcast(msg: ExtensionToWebviewMessage): void {
    const raw = msg as unknown as Record<string, unknown>
    for (const entry of this.viewRegistry.values()) entry.postMessage(raw)
  }

  /**
   * Deliver a state snapshot to a specific view, or to all views
   * when `viewId` is omitted. Replays runtime status, connection,
   * telemetry, and view-specific retained state (activity log,
   * tool executions, context assembly, diagnostic events).
   */
  private snapshotFor(viewId?: string): void {
    const deliver = viewId
      ? (msg: Record<string, unknown>) => { const entry = this.viewRegistry.get(viewId); if (entry) entry.postMessage(msg) }
      : (msg: Record<string, unknown>) => this.broadcast(msg as any)

    // Always send core runtime state
    deliver({ type: "runtimeConnection", state: this.state.connectionState } as unknown as Record<string, unknown>)
    deliver({ type: "runtimeStatus", status: this.state.running ? "running" : "idle" } as unknown as Record<string, unknown>)
    deliver({ type: "telemetryUpdate", data: this.state.getTelemetryData() } as unknown as Record<string, unknown>)

    // View-specific retained state (only when a specific viewId is targeted)
    if (viewId) {
      const short = viewId.split(".").pop() ?? viewId
      if (short === "activity") {
        // Replay activity entries in chronological order (view prepends, so newest ends up at top)
        for (const entry of this.state.activities) {
          deliver({ type: "activityUpdate", entry } as unknown as Record<string, unknown>)
        }
      } else if (short === "tools") {
        // Replay tool execution records (view replaces matching id, so full list is fine)
        for (const tool of this.state.toolExecutions) {
          deliver({ type: "toolExecutionUpdate", tool } as unknown as Record<string, unknown>)
        }
      } else if (short === "context" && this.lastContextAssembly) {
        deliver({ type: "contextAssembly", ...this.lastContextAssembly } as unknown as Record<string, unknown>)
      }
    }
  }

  /**
   * Initialise context database and GPU telemetry polling.
   * Called once from extension.ts activate().
   */
  public async initialize(context: vscode.ExtensionContext): Promise<void> {
    this.state.setConnectionState("disconnected")
    await this.initContext(context)
    this.initGpu()
    logInfo("Controller", "NotTheLeast controller initialized")
  }

  /**
   * Public entry point called by extension.ts after activation.
   * Delegates to the existing runtime initialisation logic in ensureRuntime.
   * Any failure is surfaced via the shared state and broadcasts.
   */
  public async initializeRuntime(): Promise<void> {
    try {
      await this.ensureRuntime()
    } catch (e) {
      logError("Controller", "initializeRuntime failed", { message: String(e) })
      this.state.setConnectionState("degraded")
      this.broadcast({ type: "runtimeConnection", state: "degraded" })
    }
  }

  /**
   * Broadcasts the current application state snapshot to every webview,
   * or to a specific view when `viewId` is provided.
   * Called when a view opens or re-opens so it receives the latest state
   * without waiting for the next event.
   */
  public postSnapshot(viewId?: string): void {
    this.snapshotFor(viewId)
  }

  /**
   * Creates the TrueForge runtime (agent client) if not already
   * initialised and if an agent name is configured.
   * Sets connection state to "connected" on success, "degraded" on
   * failure, and remains "disconnected" when no agent name is set.
   *
   * Concurrency-safe: concurrent calls share the same in-flight promise.
   * Retry-safe: clears initialization state on failure so a later
   * call can retry without duplicate runtime clients.
   */
  public async ensureRuntime(): Promise<void> {
    if (this.runtimeInitialized && this.runtime) return
    if (this.runtimeInitPromise) return this.runtimeInitPromise
    this.runtimeInitPromise = this.initRuntimeOnce()
    return this.runtimeInitPromise
  }

  private async initRuntimeOnce(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("trueforge")
    const agentName = cfg.get<string>("agentName", "").trim()
    if (!agentName) { this.state.setConnectionState("disconnected"); return }
    try {
      const rt = await TrueForgeRuntime.create({ baseUrl: cfg.get<string>("baseUrl", "http://localhost:8790"), agentName })
      rt.onEvent((event: AgentEvent) => this.onRuntimeEvent(event))
      this.runtime = rt
      this.runtimeInitialized = true
      this.state.setConnectionState("connected")
      this.broadcast({ type: "runtimeConnection", state: "connected" })
      logInfo("Runtime", "Connected to TrueForge")
    } catch (error) {
      this.runtimeInitialized = false
      this.runtime = undefined
      this.state.setConnectionState("degraded")
      logError("Runtime", error instanceof Error ? error.message : String(error))
      this.broadcast({ type: "error", message: error instanceof Error ? error.message : String(error) })
    } finally {
      this.runtimeInitPromise = undefined
    }
  }
  /**
   * Creates or reuses an application session with a persisted TrueForge
   * mapping. Returns the opaque application session ID, or undefined when
   * session creation cannot proceed.
   *
   * == Semantics ==
   *
   * 1. Fully initialized session reuse — if activeSessionId is set and
   *    its runtime mapping is known, return it immediately.
   * 2. Unavailable service — fail clearly. Never create a runtime session
   *    for an unpersisted app session.
   * 3. App-session creation failure — stop. No runtime session created.
   * 4. Runtime creation failure — pendingAppSessionId retained so the
   *    next call reuses it. No active session published.
   * 5. Mapping persistence failure — both pending fields retained. On
   *    retry, only the mapping update is retried.
   * 6. Full success — all three steps complete. activeSessionId is set,
   *    pending fields cleared.
   */
  private async ensureSession(): Promise<string | undefined> {
    if (this.activeSessionId && this.runtimeSessionIds.has(this.activeSessionId)) {
      return this.activeSessionId
    }
    if (!this.service) {
      logError("Runtime", "Context service not available — cannot create session")
      return undefined
    }
    try {
      if (!this.pendingAppSessionId) {
        const appId = `s-${randomUUID()}`
        await this.service.createSession("Agent Session", appId)
        this.pendingAppSessionId = appId
      }
      if (!this.pendingRuntimeSessionId) {
        if (!this.runtime) {
          logError("Runtime", "TrueForge runtime not available — cannot create runtime session")
          return undefined
        }
        const tfs = await this.runtime.createSession()
        this.pendingRuntimeSessionId = tfs.id
      }
      await this.service.setTrueForgeSessionId(this.pendingAppSessionId, this.pendingRuntimeSessionId)
      this.runtimeSessionIds.set(this.pendingAppSessionId, this.pendingRuntimeSessionId)
      this.state.setActiveSession(this.pendingAppSessionId)
      this.activeSessionId = this.pendingAppSessionId
      this.pendingAppSessionId = undefined
      this.pendingRuntimeSessionId = undefined
      return this.activeSessionId
    } catch (e2) {
      logError("Runtime", "Session creation failed", { message: String(e2) })
      this.state.setConnectionState("degraded")
      return undefined
    }
  }

  /**
   * Dispatches a user prompt through the full lifecycle:
   * 1. Ensure runtime is initialized (retry-safe)
   * 2. Resolve or create a runtime session
   * 3. Load workspace files and assemble context
   * 4. Format the prompt with context
   * 5. Send the turn to the TrueForge runtime
   * 6. Events flow back through onRuntimeEvent for broadcast to webviews
   *
   * Every terminal path (error, cancellation, completion) sets
   * runtimeStatus to "idle" and sets the appropriate terminal stage.
   */
  public async handlePrompt(text: string, attachments?: Array<any>): Promise<void> {
    logInfo("Prompt", "handlePrompt: " + text.slice(0, 80))

    // 1. Ensure runtime is available (retry-safe)
    await this.ensureRuntime().catch(() => {})
    if (!this.runtime) {
      this.broadcast({ type: "error", message: "Runtime not available. Check configuration and connection." })
      return
    }

    // 2. Broadcast running status immediately — Send button disabled, Cancel available
    this.state.recordTiming({ submittedAt: Date.now() })
    this.state.incrementRequestCount()
    this.state.setStage("prompt.submitted")
    this.state.setRunning(true)
    this.broadcast({ type: "runtimeStatus", status: "running" })
    this.broadcast({ type: "telemetryUpdate", data: this.state.getTelemetryData() })
    this.broadcast({ type: "userMessage", text, attachments })
    this.state.recordActivity("event", "Prompt submitted")

    // Resolve or create a session
    let runtimeSid: string | undefined
    if (this.activeSessionId) {
      runtimeSid = this.runtimeSessionIds.get(this.activeSessionId)
    }
    if (!runtimeSid) {
      this.state.setStage("resolving.session")
      const appSid = await this.ensureSession()
      if (!appSid) {
        this.state.setStage("failed")
        this.state.setRunning(false)
        this.state.recordTiming({ completedAt: Date.now() })
        this.broadcast({ type: "runtimeStatus", status: "idle" })
        this.broadcast({ type: "telemetryUpdate", data: this.state.getTelemetryData() })
        this.broadcast({ type: "error", message: "Session creation failed." })
        return
      }
      runtimeSid = this.runtimeSessionIds.get(appSid)
    }
    this.state.recordTiming({ sessionResolvedAt: Date.now() })

    // 3. Assemble context from DB candidates AND workspace files
    this.state.setStage("assembling.context")
    let formattedPrompt = text
    try {
      const budget = vscode.workspace.getConfiguration("trueforge").get<number>("contextBudget", 4000)
      let candidates: ContextCandidate[] = []
      try {
        if (this.activeSessionId && this.service) {
          candidates = (await this.service.listSessionContext(this.activeSessionId)) ?? []
        }
      } catch {
        logWarn("Context", "Failed to list session context", { message: "Continuing with empty context" })
      }
      const workspaceFiles = await loadWorkspaceFiles()
      const assembly = assembleContext({ candidates, query: text, files: workspaceFiles, budget })

      // Broadcast context assembly summary
      const assemblyMsg: Record<string, unknown> = {
        type: "contextAssembly",
        budget: assembly.budget,
        usedTokens: Math.min(assembly.budget, assembly.selected.reduce((s, c) => s + c.candidate.block.tokenEstimate, 0)),
        selected: assembly.selected.map(s => ({ title: s.candidate.block.title, tokenEstimate: s.candidate.block.tokenEstimate, reason: s.reason })),
        omitted: assembly.omitted.map(o => ({ title: o.candidate.block.title, tokenEstimate: o.candidate.block.tokenEstimate, reason: "budget" as const })),
        retrieved: assembly.retrieved.map(r => ({ path: r.path, startLine: r.startLine, endLine: r.endLine, reason: "retrieved" as const })),
      } as unknown as Record<string, unknown>
      this.lastContextAssembly = assemblyMsg
      this.broadcast(assemblyMsg as any)

      formattedPrompt = formatPromptWithContext(text, assembly)
    } catch (contextError) {
      logError("Context", "Context loading/assembly failed", { message: String(contextError) })
      this.state.setStage("failed")
      this.state.setRunning(false)
      this.state.recordTiming({ completedAt: Date.now() })
      this.broadcast({ type: "runtimeStatus", status: "idle" })
      this.broadcast({ type: "telemetryUpdate", data: this.state.getTelemetryData() })
      this.broadcast({ type: "error", message: "Context loading failed: " + (contextError instanceof Error ? contextError.message : String(contextError)) })
      return
    }

    // 4. Send the turn
    this.state.recordTiming({ contextAssembledAt: Date.now() })
    this.state.setStage("sending.request")
    this.state.recordTiming({ requestDispatchedAt: Date.now() })
    try {
      if (!runtimeSid) throw new Error("No runtime session ID available")
      await this.runtime.sendTurn(runtimeSid, formattedPrompt)
    } catch (err) {
      logError("Runtime", "sendTurn failed", { sid: runtimeSid, message: String(err) })
      this.state.setStage("failed")
      this.state.setRunning(false)
      this.state.recordTiming({ completedAt: Date.now() })
      this.broadcast({ type: "runtimeStatus", status: "idle" })
      this.broadcast({ type: "telemetryUpdate", data: this.state.getTelemetryData() })
      this.broadcast({ type: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }
  /** Cancels the currently active turn. Sets stage to "cancelled" and broadcasts the event. */
  public async handleCancel(): Promise<void> {
    if (!this.runtime || !this.activeSessionId) return
    const csid = this.runtimeSessionIds.get(this.activeSessionId)
    if (csid) await this.runtime.cancel(csid)
    this.state.setStage("cancelled")
    this.state.setRunning(false)
    this.state.recordTiming({ completedAt: Date.now() })
    this.broadcast({ type: "runtimeStatus", status: "idle" })
    this.broadcast({ type: "telemetryUpdate", data: this.state.getTelemetryData() })
    this.broadcast({ type: "requestCancelled", reason: "user-cancelled" })
  }
  /**
   * Routes a user's approval decision (allow / deny) to the TrueForge runtime
   * for a pending tool call. Looks up the pending approval by threadId:toolCallId.
   */
  public async handleToolApproval(msg: { threadId?: string; toolCallId?: string; decision?: string }): Promise<void> {
    if (!this.runtime || !msg.threadId || !msg.toolCallId) return
    const key = msg.threadId + ":" + msg.toolCallId; const p = this.pendingApprovals.get(key)
    if (!p) return
    try { this.state.recordTiming({ approvalRespondedAt: Date.now() }); await this.runtime.respondToApproval(p.runtimeSessionId, msg.threadId, msg.toolCallId, { status: msg.decision === "allow" ? "allow" : "deny" }); this.pendingApprovals.delete(key); this.state.recordActivity("approval", msg.decision === "allow" ? "Tool approved" : "Tool denied", msg.toolCallId) }
    catch (err) { this.broadcast({ type: "error", message: err instanceof Error ? err.message : String(err) }) }
  }
  /**
   * Routes context management actions from the webview (store, attach,
   * move, copy) to the ContextService.
   */
  public async handleContextAction(msg: { action: string; blockId: string; destinationSessionId?: string }): Promise<void> {
    if (!this.service || !this.activeSessionId) return
    try {
      if (msg.action === "store") {
        // Store the block in the Context Library with project visibility
        await this.service.store(this.activeSessionId, msg.blockId, "project")
      } else if (msg.action === "attach") {
        // Attach the block to the current session with task scope
        await this.service.attach(this.activeSessionId, msg.blockId, "task")
      } else if (msg.action === "move" && msg.destinationSessionId) {
        await this.service.move(this.activeSessionId, msg.destinationSessionId, msg.blockId)
      } else if (msg.action === "copy" && msg.destinationSessionId) {
        await this.service.copy(this.activeSessionId, msg.destinationSessionId, msg.blockId)
      } else {
        logWarn("Controller", "Unknown context action", { action: msg.action })
        return
      }
    } catch (err) {
      logError("Controller", "Context action failed", { action: msg.action, blockId: msg.blockId, message: String(err) })
      this.broadcast({ type: "error", message: err instanceof Error ? err.message : String(err) })
      return
    }
    await this.postSnapshot()
  }

  /**
   * Exports the redacted diagnostics JSON to the clipboard and shows a
   * notification. Reports clipboard/export errors visibly.
   */
  public async handleExportDiagnostics(): Promise<void> {
    try {
      const json = exportDiagnosticsJson()
      await vscode.env.clipboard.writeText(json)
      void vscode.window.showInformationMessage("Diagnostics report copied to clipboard.")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void vscode.window.showErrorMessage("Failed to export diagnostics: " + message)
      logError("Controller", "Export diagnostics failed", { message })
    }
  }

  /**
   * Resolves a user attachment query ("#fileName" or "@symbolName") to
   * file or symbol results for the webview's attachment picker.
   */
  public async resolveAttachment(query: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (!root) return
    const results: Array<any> = []
    if (query.startsWith("#")) {
      const files = await vscode.workspace.findFiles("**/*" + query.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "*", "**/{node_modules,.git,out,dist,coverage}/**", 10)
      for (const f of files) results.push({ type: "file", path: vscode.workspace.asRelativePath(f, false), label: f.fsPath.replace(/^.*[\\/]/, "") })
    } else if (query.startsWith("@")) {
      const syms = await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", query.slice(1))
      if (syms) for (const s of syms) results.push({ type: "symbol", path: s.location.uri.fsPath, label: s.name, startLine: s.location.range.start.line + 1, endLine: s.location.range.end.line + 1 })
    }
    this.broadcast({ type: "attachmentResolved", query, results })
  }

  /**
   * Routes streaming agent events from TrueForgeRuntime to the shared state
   * and broadcasts the corresponding ExtensionToWebviewMessage variants.
   * This is the main event loop for the controller.
   */
  private onRuntimeEvent(event: AgentEvent): void {
    switch (event.type) {
      case "model.message.delta":
        this.state.setLastEventTimestamp(Date.now()); if (!this.state.timing.firstEventAt) this.state.recordTiming({ firstEventAt: Date.now() }); if (!this.state.timing.firstDeltaAt) this.state.recordTiming({ firstDeltaAt: Date.now() }); if (!this.state.timing.firstVisibleTextAt) this.state.recordTiming({ firstVisibleTextAt: Date.now() })
        this.broadcast({ type: "assistantDelta", text: event.text, reasoning: event.reasoning, sessionId: event.sessionId }); break
      case "model.message": this.state.setLastEventTimestamp(Date.now()); this.broadcast({ type: "assistantMessage", text: event.text, reasoning: event.reasoning, sessionId: event.sessionId }); break
      case "tool.approval_required":
        for (const tc of event.toolCalls) this.pendingApprovals.set(event.threadId + ":" + tc.id, { appSessionId: "", runtimeSessionId: event.sessionId ?? "", threadId: event.threadId, toolCallId: tc.id })
        this.state.setStage("awaiting.approval"); this.state.recordActivity("tool", "Approval needed", event.toolCalls.map(tc => tc.toolName ?? tc.id).join(", "))
        this.broadcast({ type: "toolApprovalRequired", threadId: event.threadId, toolCalls: event.toolCalls ?? [], sessionId: event.sessionId }); break
      case "turn.done": {
        const tds = event.state; this.state.recordTiming({ finalMessageAt: Date.now(), completedAt: Date.now() }); this.state.setActiveTurn(undefined)
        let termOut: { text: string; reasoning?: string } | null = null
        if (tds.status === "done" && (tds as any).output && (tds as any).output.type === "model.message") {
          const out = (tds as any).output; const content = out.content ?? ""
          const txt = typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => ("text" in p ? p.text : "")).join("") : ""
          if (txt) termOut = { text: txt, reasoning: out.reasoningContent }
        }
        if (termOut && termOut.text.length > 0) {
          this.broadcast({ type: "assistantFinalMessage", text: termOut.text, reasoning: termOut.reasoning })
          this.state.setStage("completed")
          this.state.setRunning(false)
          this.broadcast({ type: "runtimeStatus", status: "idle" })
          this.broadcast({ type: "terminalEventReport", report: { terminalStatus: "done", terminalOutputPresent: true, terminalOutputLength: termOut.text.length } })
          this.broadcast({ type: "requestCompleted" })
        } else if (tds.status === "error") {
          const m = (tds as any).message || "Unknown error"
          this.state.setStage("failed")
          this.state.setRunning(false)
          this.broadcast({ type: "runtimeStatus", status: "idle" })
          this.broadcast({ type: "error", message: m })
          this.broadcast({ type: "requestFailed", errorMessage: m })
        } else if (tds.status === "cancelled") {
          this.state.setStage("cancelled")
          this.state.setRunning(false)
          this.broadcast({ type: "runtimeStatus", status: "idle" })
          this.broadcast({ type: "requestCancelled", reason: (tds as any).reason || "cancelled" })
        } else {
          this.state.setStage("completed")
          this.state.setRunning(false)
          this.broadcast({ type: "runtimeStatus", status: "idle" })
          this.broadcast({ type: "terminalEventReport", report: { terminalStatus: "done", terminalOutputPresent: false } })
        }
        break
      }
      case "usage": this.state.recordUsage(event.inputTokens, event.outputTokens, true); break
      case "session.created": this.state.setConnectionState("connected"); break
      case "connection.changed": this.state.setConnectionState(event.state); break
      case "error": this.state.incrementErrorCount(); this.broadcast({ type: "error", message: event.message }); break
    }
    this.broadcast({ type: "telemetryUpdate", data: this.state.getTelemetryData() })
  }
  /**
   * Opens or creates the SQLite context database at
   * `{globalStorageUri}/context.sqlite`.
   */
  private async initContext(context: vscode.ExtensionContext): Promise<void> {
    try { this.database = await ContextDatabase.open({ filePath: vscode.Uri.joinPath(context.globalStorageUri, "context.sqlite").fsPath }); this.service = new ContextService(this.database) } catch (e) { logWarn("Context", "Init failed", { message: String(e) }) }
  }
  /**
   * Starts a 5-second interval polling nvidia-smi for GPU metrics.
   * Telemetry is broadcast as {@link ExtensionToWebviewMessage} `"telemetryUpdate"`.
   */
  private initGpu(): void {
    if (!vscode.workspace.getConfiguration("nottheleast").get<boolean>("enableGpuTelemetry", true)) return
    this.gpuPollTimer = setInterval(async () => { const info = await readGpuTelemetry(); if (info.available) { const t = this.state.getTelemetryData(); t.gpuName = info.name; t.gpuUtilization = info.utilization; t.gpuMemoryUsed = info.memoryUsed; t.gpuMemoryTotal = info.memoryTotal; t.gpuTemperature = info.temperature; this.broadcast({ type: "telemetryUpdate", data: t }) } }, 5000)
    this.disposables.push({ dispose: () => { if (this.gpuPollTimer) clearInterval(this.gpuPollTimer) } })
  }
  /** Clean up disposables (GPU poller, etc.). Called from deactivate(). */
  public dispose(): void {
    for (const d of this.disposables) d.dispose()
    this.disposables = []
  }
}

/**
 * Formats a user prompt with assembled context into a single string.
 * Includes selected context blocks and retrieved workspace snippets.
 * The original prompt is returned unchanged when there is no additional context.
 *
 * Pure synchronous function — never reads files or performs async I/O.
 */
function formatPromptWithContext(
  prompt: string,
  assembly: ReturnType<typeof assembleContext>,
): string {
  const selected = assembly.selected
    .map(({ candidate }) => `### ${candidate.block.title}\n${candidate.block.content}`)
    .join("\n\n")
  const retrieved = assembly.retrieved
    .map(({ path, text, startLine, endLine }) => `### ${path}:${startLine}-${endLine}\n${text}`)
    .join("\n\n")
  if (!selected && !retrieved) {
    return prompt
  }
  return `${prompt}\n\n<context>\n${[selected, retrieved].filter(Boolean).join("\n\n")}\n</context>`
}

/**
 * Loads workspace files for context assembly with bounded limits.
 *
 * Limits (documented in code):
 * - maxFiles: 20  (files discovered)
 * - maxCharsPerFile: 4000  (per-file read cap)
 * - maxTotalBytes: 80_000  (total across all files)
 *
 * File ordering: deterministic sorted by relative path.
 * Exclusions: .git, node_modules, out, dist, coverage.
 * Skips: unreadable, binary and oversized files.
 */
async function loadWorkspaceFiles(): Promise<Array<{ path: string; content: string }>> {
  const maxFiles = 20
  const maxCharsPerFile = 4000
  const maxTotalBytes = 80_000

  const uris = await vscode.workspace.findFiles(
    "**/*",
    "**/{node_modules,.git,out,dist,coverage}/**",
    maxFiles,
  )
  if (!uris.length) return []

  // Deterministic order by relative path
  uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath))

  const results: Array<{ path: string; content: string }> = []
  let totalBytes = 0

  for (const uri of uris) {
    if (totalBytes >= maxTotalBytes) break
    try {
      const doc = await vscode.workspace.openTextDocument(uri)
      const text = doc.getText()
      if (text.length > maxCharsPerFile) continue
      const bytes = Buffer.byteLength(text, "utf-8")
      if (bytes > maxTotalBytes - totalBytes) continue
      results.push({
        path: vscode.workspace.asRelativePath(uri, false),
        content: text,
      })
      totalBytes += bytes
    } catch {
      // Skip unreadable files (binary, permissions, etc.)
    }
  }
  return results
}
