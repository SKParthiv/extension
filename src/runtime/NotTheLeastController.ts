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
  public readonly state = new SharedRuntimeState()
  private runtime?: TrueForgeRuntime
  private runtimeInitialized = false
  private disposables: vscode.Disposable[] = []
  private database?: ContextDatabase
  private service?: ContextService
  private readonly runtimeSessionIds = new Map<string, string>()
  private readonly pendingApprovals = new Map<string, { appSessionId: string; runtimeSessionId: string; threadId: string; toolCallId: string }>()
  private activeSessionId?: string
  private gpuPollTimer?: ReturnType<typeof setInterval>
  private _broadcast: (msg: Record<string, unknown>) => void = () => {}
  public setBroadcast(fn: (msg: Record<string, unknown>) => void): void { this._broadcast = fn }
  private broadcast(msg: ExtensionToWebviewMessage): void { this._broadcast(msg as unknown as Record<string, unknown>) }

  public async initialize(context: vscode.ExtensionContext): Promise<void> {
    this.state.setConnectionState("disconnected")
    await this.initContext(context)
    this.initGpu()
    logInfo("Controller", "NotTheLeast controller initialized")
  }
  public registerView(viewId: string): void { this.ensureRuntime() }
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
  private async ensureSession(): Promise<string | undefined> {
    if (!this.runtime) return undefined
    try { const s = await this.runtime.createSession(); const e = "s-" + Date.now(); this.runtimeSessionIds.set(e, s.id); this.state.setActiveSession(e); this.activeSessionId = e; return e }
    catch (e2) { logError("Runtime", "Session creation failed"); this.state.setConnectionState("degraded"); return undefined }
  }

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
  public async handleCancel(): Promise<void> {
    if (!this.runtime || !this.activeSessionId) return
    const csid = this.runtimeSessionIds.get(this.activeSessionId)
    if (csid) await this.runtime.cancel(csid)
    this.state.setStage("cancelled"); this.state.recordTiming({ completedAt: Date.now() })
    this.broadcast({ type: "requestCancelled", reason: "user-cancelled" })
  }
  public async handleToolApproval(msg: { threadId?: string; toolCallId?: string; decision?: string }): Promise<void> {
    if (!this.runtime || !msg.threadId || !msg.toolCallId) return
    const key = msg.threadId + ":" + msg.toolCallId; const p = this.pendingApprovals.get(key)
    if (!p) return
    try { this.state.recordTiming({ approvalRespondedAt: Date.now() }); await this.runtime.respondToApproval(p.runtimeSessionId, msg.threadId, msg.toolCallId, { status: msg.decision === "allow" ? "allow" : "deny" }); this.pendingApprovals.delete(key); this.state.recordActivity("approval", msg.decision === "allow" ? "Tool approved" : "Tool denied", msg.toolCallId) }
    catch (err) { this.broadcast({ type: "error", message: err instanceof Error ? err.message : String(err) }) }
  }
  public async handleContextAction(msg: any): Promise<void> {
    if (!this.service) return
    if (msg.action === "store") { const ed = vscode.window.activeTextEditor; if (ed) this.service.storeBlock(ed.document.getText(), { source: "file", path: vscode.workspace.asRelativePath(ed.document.uri, false) }, ed.document.fileName, this.activeSessionId) }
    else if (msg.action === "attach") this.service.setBlockStatus(msg.blockId, "active")
    else if (msg.action === "move" && msg.destinationSessionId) this.service.moveBlockToSession(msg.blockId, this.activeSessionId ?? "", msg.destinationSessionId)
    else if (msg.action === "copy" && msg.destinationSessionId) this.service.copyBlockToSession(msg.blockId, this.activeSessionId ?? "", msg.destinationSessionId)
    else this.service.setBlockStatus(msg.blockId, "archived")
    await this.postSnapshot()
  }
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
  private async initContext(context: vscode.ExtensionContext): Promise<void> {
    try { this.database = await ContextDatabase.open({ filePath: vscode.Uri.joinPath(context.globalStorageUri, "context.sqlite").fsPath }); this.service = new ContextService(this.database) } catch (e) { logWarn("Context", "Init failed", { message: String(e) }) }
  }
  private initGpu(): void {
    if (!vscode.workspace.getConfiguration("nottheleast").get<boolean>("enableGpuTelemetry", true)) return
    this.gpuPollTimer = setInterval(async () => { const info = await readGpuTelemetry(); if (info.available) { const t = this.state.getTelemetryData(); t.gpuName = info.name; t.gpuUtilization = info.utilization; t.gpuMemoryUsed = info.memoryUsed; t.gpuMemoryTotal = info.memoryTotal; t.gpuTemperature = info.temperature; this.broadcast({ type: "telemetryUpdate", data: t }) } }, 5000)
    this.disposables.push({ dispose: () => { if (this.gpuPollTimer) clearInterval(this.gpuPollTimer) } })
  }
}


function fmtCtx(prompt: string, assembly: ReturnType<typeof assembleContext>): string {
  const files = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,out,dist,coverage}/**")
  const results: Array<{ path: string; content: string }> = []
  for (const f of files.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
    try { const doc = await vscode.workspace.openTextDocument(f); if (doc.getText().length <= 40000) results.push({ path: vscode.workspace.asRelativePath(f, false), content: doc.getText() }) } catch (e) { if (!(e instanceof vscode.FileSystemError)) throw e }
  }
  return results
}
