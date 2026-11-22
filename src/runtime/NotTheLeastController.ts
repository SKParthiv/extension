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
import { TrueForgeRuntime } from "./TrueForgeRuntime"
import type { AgentEvent } from "./AgentRuntime"
import { SharedRuntimeState } from "./SharedState"
import { logInfo, logWarn, logError, exportDiagnosticsJson } from "./NotTheLeastLogger"
import { readGpuTelemetry } from "./GpuTelemetry"
import { assembleContext } from "../context/ContextAssembler"
import { ContextService } from "../context/ContextService"
import { ContextDatabase } from "../context/db/Database"
import { detectConflicts } from "../context/ContextConflicts"
import type { ExtensionToWebviewMessage } from "../shared/messages"

export class NotTheLeastController {
  /** Ephemeral reactive state shared with the webview via broadcasts. */
  public readonly state = new SharedRuntimeState()
  private runtime?: TrueForgeRuntime
  private runtimeInitialized = false
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
  private gpuPollTimer?: ReturnType<typeof setInterval>

  /**
   * Registry of connected webview views keyed by viewId.
   * Each entry stores a `postMessage` call so the controller can
   * send typed messages to individual or all registered views.
   */
  private readonly viewRegistry = new Map<string, (msg: Record<string, unknown>) => void>()
  /**
   * Monotonic generation counter for stale-disposal protection.
   */
  private viewGeneration = 0

  /**
   * Register a webview with the controller. Returns a disposable
   * that unregisters the view when called. Uses a monotonic
   * generation counter to ensure a stale disposable never removes
   * a newer registration for the same viewId.
   */
  public registerView(
    viewId: string,
    postMessage: (msg: Record<string, unknown>) => void,
  ): vscode.Disposable {
    const gen = ++this.viewGeneration
    this.viewRegistry.set(viewId, postMessage)
    void this.ensureRuntime()
    return {
      dispose: () => {
        // Only remove if our generation is still the current one
        if (this.viewGeneration === gen) {
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
    for (const fn of this.viewRegistry.values()) fn(raw)
  }

  /**
   * Deliver a state snapshot to a specific view, or to all views
   * when `viewId` is omitted.
   */
  private snapshotFor(viewId?: string): void {
    const deliver = viewId
      ? (msg: Record<string, unknown>) => { const fn = this.viewRegistry.get(viewId); if (fn) fn(msg) }
      : (msg: Record<string, unknown>) => this.broadcast(msg as any)
    deliver({ type: "runtimeConnection", state: this.state.connectionState } as unknown as Record<string, unknown>)
    deliver({ type: "runtimeStatus", status: this.state.running ? "running" : "idle" } as unknown as Record<string, unknown>)
    deliver({ type: "telemetryUpdate", data: this.state.getTelemetryData() } as unknown as Record<string, unknown>)
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
   */
  public async ensureRuntime(): Promise<void> {
    if (this.runtimeInitialized) return
    const cfg = vscode.workspace.getConfiguration("trueforge")
    const agentName = cfg.get<string>("agentName", "").trim()
    if (!agentName) { this.state.setConnectionState("disconnected"); return }
    this.runtimeInitialized = true
    try {
      this.runtime = await TrueForgeRuntime.create({ baseUrl: cfg.get<string>("baseUrl", "http://localhost:8790"), agentName })
      this.runtime.onEvent((event: AgentEvent) => this.onRuntimeEvent(event))
      this.state.setConnectionState("connected")
      this.broadcast({ type: "runtimeConnection", state: "connected" })
      logInfo("Runtime", "Connected to TrueForge")
    } catch (error) {
      this.state.setConnectionState("degraded")
      logError("Runtime", error instanceof Error ? error.message : String(error))
      this.broadcast({ type: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }
  /**
   * Creates a TrueForge runtime session and maps it to an application-level
   * session ID (prefixed "s-"). Returns the application session ID, or
   * undefined on failure.
   */
  private async ensureSession(): Promise<string | undefined> {
    if (!this.runtime) return undefined
    try { const s = await this.runtime.createSession(); const e = "s-" + Date.now(); this.runtimeSessionIds.set(e, s.id); this.state.setActiveSession(e); this.activeSessionId = e; return e }
    catch (e2) { logError("Runtime", "Session creation failed"); this.state.setConnectionState("degraded"); return undefined }
  }

  /**
   * Dispatches a user prompt through the full lifecycle:
   * 1. Resolve or create a runtime session
   * 2. Assemble context from the context database + workspace files
   * 3. Send the turn to the TrueForge runtime
   * 4. Events flow back through onRuntimeEvent for broadcast to webviews
   */
  public async handlePrompt(text: string, attachments?: Array<any>): Promise<void> {
    logInfo("Prompt", "sendPrompt: " + text.slice(0, 80))
    if (!this.runtime) { this.broadcast({ type: "error", message: "Runtime not initialized." }); return }
    this.state.recordTiming({ submittedAt: Date.now() }); this.state.incrementRequestCount(); this.state.setStage("prompt.submitted")
    this.broadcast({ type: "userMessage", text, attachments }); this.state.recordActivity("event", "Prompt submitted")
    this.state.setStage("resolving.session")
    let sid: string | undefined
    for (const [e, t] of this.runtimeSessionIds) { if (e === this.activeSessionId) { sid = t; break } }
    if (!sid) { sid = await this.ensureSession(); if (!sid) { this.state.setStage("failed"); return } }
    this.state.recordTiming({ sessionResolvedAt: Date.now() }); this.state.setStage("assembling.context")
    let pt = text
    if (this.service) {
      const budget = vscode.workspace.getConfiguration("trueforge").get<number>("contextBudget", 4000)
      const blocks = this.service.listBlocks(); const files = await loadFiles()
      const candidates = blocks.map(({ block, membership }) => ({ block: { id: block.id, title: block.title, content: block.content, tokenEstimate: block.tokenEstimate }, priority: membership.priority as any, position: membership.position, reason: (membership.pinned ? "pinned" : "position") as any }))
      const a = assembleContext({ candidates, query: text, files, budget })
      this.broadcast({ type: "contextAssembly", budget: a.budget, usedTokens: Math.min(a.budget, a.selected.reduce((s, c) => s + c.candidate.block.tokenEstimate, 0)), selected: a.selected.map(s => ({ title: s.candidate.block.title, tokenEstimate: s.candidate.block.tokenEstimate, reason: s.reason })), omitted: a.omitted.map(o => ({ title: o.candidate.block.title, tokenEstimate: o.candidate.block.tokenEstimate, reason: "budget" as const })), retrieved: a.retrieved.map(r => ({ path: r.path, startLine: r.startLine, endLine: r.endLine, reason: "retrieved" as const })) })
      pt = fmtCtx(text, a)
    }
    this.state.recordTiming({ contextAssembledAt: Date.now() }); this.state.setStage("sending.request"); this.state.recordTiming({ requestDispatchedAt: Date.now() })
    try { await this.runtime.sendTurn(sid, pt) } catch (err) {
      logError("Runtime", "sendTurn failed", { sid, message: String(err) })
      this.state.setStage("failed"); this.state.recordTiming({ completedAt: Date.now() })
      this.broadcast({ type: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }
  /** Cancels the currently active turn. Sets stage to "cancelled" and broadcasts the event. */
  public async handleCancel(): Promise<void> {
    if (!this.runtime || !this.activeSessionId) return
    const csid = this.runtimeSessionIds.get(this.activeSessionId)
    if (csid) await this.runtime.cancel(csid)
    this.state.setStage("cancelled"); this.state.recordTiming({ completedAt: Date.now() })
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
   * move, copy, archive) to the ContextService.
   */
  public async handleContextAction(msg: any): Promise<void> {
    if (!this.service) return
    if (msg.action === "store") { const ed = vscode.window.activeTextEditor; if (ed) this.service.storeBlock(ed.document.getText(), { source: "file", path: vscode.workspace.asRelativePath(ed.document.uri, false) }, ed.document.fileName, this.activeSessionId) }
    else if (msg.action === "attach") this.service.setBlockStatus(msg.blockId, "active")
    else if (msg.action === "move" && msg.destinationSessionId) this.service.moveBlockToSession(msg.blockId, this.activeSessionId ?? "", msg.destinationSessionId)
    else if (msg.action === "copy" && msg.destinationSessionId) this.service.copyBlockToSession(msg.blockId, this.activeSessionId ?? "", msg.destinationSessionId)
    else this.service.setBlockStatus(msg.blockId, "archived")
    await this.postSnapshot()
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
      case "turn.update": if (event.state && (event.state as any).status === "paused") this.broadcast({ type: "turnPaused", status: "paused", threadId: event.threadId ?? undefined }); break
      case "turn.done": {
        const tds = event.state; this.state.recordTiming({ finalMessageAt: Date.now(), completedAt: Date.now() }); this.state.setActiveTurn(undefined)
        let termOut: { text: string; reasoning?: string } | null = null
        if (tds.status === "done" && (tds as any).output && (tds as any).output.type === "model.message") {
          const out = (tds as any).output; const content = out.content ?? ""
          const txt = typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => ("text" in p ? p.text : "")).join("") : ""
          if (txt) termOut = { text: txt, reasoning: out.reasoningContent }
        }
        if (termOut && termOut.text.length > 0) { this.broadcast({ type: "assistantFinalMessage", text: termOut.text, reasoning: termOut.reasoning }); this.state.setStage("completed"); this.broadcast({ type: "runtimeStatus", status: "idle" }); this.broadcast({ type: "terminalEventReport", report: { terminalStatus: "done", terminalOutputPresent: true, terminalOutputLength: termOut.text.length } }); this.broadcast({ type: "requestCompleted" }) }
        else if (tds.status === "error") { const m = (tds as any).message || "Unknown error"; this.state.setStage("failed"); this.broadcast({ type: "error", message: m }); this.broadcast({ type: "requestFailed", errorMessage: m }) }
        else if (tds.status === "cancelled") { this.state.setStage("cancelled"); this.broadcast({ type: "requestCancelled", reason: (tds as any).reason || "cancelled" }) }
        else { this.state.setStage("completed"); this.broadcast({ type: "terminalEventReport", report: { terminalStatus: "done", terminalOutputPresent: false } }); this.broadcast({ type: "runtimeStatus", status: "idle" }) }
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
 * Appends workspace file content as context to the user prompt.
 * 
 * KNOWN ISSUE: This function uses `await` without `async`, ignores the
 * `assembly` parameter, and returns an array when the return type says
 * `string`. It is broken at runtime. A fix requires:
 *   1. Marking the function `async`
 *   2. Using `assembly.selected` and `assembly.retrieved` instead of
 *      reloading all workspace files
 *   3. Returning the formatted prompt string
 */
async function fmtCtx(prompt: string, assembly: ReturnType<typeof assembleContext>): string {
  const files = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,out,dist,coverage}/**")
  const results: Array<{ path: string; content: string }> = []
  for (const f of files.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
    try { const doc = await vscode.workspace.openTextDocument(f); if (doc.getText().length <= 40000) results.push({ path: vscode.workspace.asRelativePath(f, false), content: doc.getText() }) } catch (e) { if (!(e instanceof vscode.FileSystemError)) throw e }
  }
  return results
}
