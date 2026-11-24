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
import { realpathSync } from "node:fs"
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
import {
  attachmentTokenEstimate,
  formatPromptWithContext,
  type PromptAttachment,
  type ResolvedAttachment,
} from "../context/PromptContext"
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
  /** Serializes create / rename / switch so overlapping ops cannot mix session state. */
  private sessionOpGate: Promise<unknown> = Promise.resolve()
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
      } else if (short === "context") {
        if (this.lastContextAssembly) {
          deliver({ type: "contextAssembly", ...this.lastContextAssembly } as unknown as Record<string, unknown>)
        }
        const snap = this.getContextSnapshotSync()
        if (snap) {
          deliver(snap as unknown as Record<string, unknown>)
        }
      } else if (short === "chat") {
        const sessions = this.sessionListItems()
        const activeSessionId = this.activeSessionId ?? sessions[0]?.id ?? ""
        deliver({ type: "sessionsList", activeSessionId, sessions } as unknown as Record<string, unknown>)
      }
    } else {
      const snap = this.getContextSnapshotSync()
      if (snap) {
        deliver(snap as unknown as Record<string, unknown>)
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
  private enqueueSessionOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sessionOpGate.then(fn, fn)
    this.sessionOpGate = run.then(() => undefined, () => undefined)
    return run
  }

  private sessionListItems(): Array<{ id: string; title: string; ready: boolean }> {
    if (!this.service) return []
    return this.service.listSessions().map((s) => ({
      id: s.id,
      title: s.title,
      ready: Boolean(s.trueforgeSessionId || this.runtimeSessionIds.get(s.id)),
    }))
  }

  private publishSessionState(sessionId: string): void {
    const sessions = this.sessionListItems()
    this.broadcast({ type: "sessionChanged", sessionId, sessions })
    this.broadcast({ type: "sessionsList", activeSessionId: sessionId, sessions })
    const snap = this.getContextSnapshotSync()
    if (snap) {
      this.broadcast(snap)
    }
  }

  private sessionOpBlocked(kind: "switch" | "create"): boolean {
    if (this.state.running) {
      this.broadcast({
        type: "error",
        message: kind === "switch"
          ? "Cannot switch sessions while a turn is actively running."
          : "Cannot create session while a turn is actively running.",
      })
      return true
    }
    if (this.pendingApprovals.size > 0) {
      this.broadcast({
        type: "error",
        message: kind === "switch"
          ? "Cannot switch sessions while tool approvals are pending."
          : "Cannot create session while tool approvals are pending.",
      })
      return true
    }
    return false
  }

  /**
   * Hydrate `runtimeSessionIds` from SQLite and restore the last-touched
   * application session (`listSessions` is ordered by `updated_at DESC`).
   */
  public hydratePersistedSessions(): void {
    if (!this.service) return
    const sessions = this.service.listSessions()
    for (const s of sessions) {
      if (s.trueforgeSessionId) {
        this.runtimeSessionIds.set(s.id, s.trueforgeSessionId)
      }
    }
    if (sessions.length > 0 && !this.activeSessionId) {
      this.activeSessionId = sessions[0].id
      this.state.setActiveSession(sessions[0].id)
    }
  }

  /**
   * Reuse a persisted TrueForge ID, or create one when the mapping is incomplete.
   * Never creates a second TrueForge session when a mapping already exists.
   */
  private async bindRuntimeSession(sessionId: string): Promise<boolean> {
    if (this.runtimeSessionIds.has(sessionId)) return true
    const existing = this.service?.getSession(sessionId)
    if (existing?.trueforgeSessionId) {
      this.runtimeSessionIds.set(sessionId, existing.trueforgeSessionId)
      return true
    }
    if (!this.runtime || !this.service) return false
    try {
      const tfs = await this.runtime.createSession()
      await this.service.setTrueForgeSessionId(sessionId, tfs.id)
      this.runtimeSessionIds.set(sessionId, tfs.id)
      return true
    } catch (error) {
      logWarn("Runtime", "Runtime session bind deferred", { sessionId, message: String(error) })
      return false
    }
  }

  /**
   * Creates or reuses an application session with a persisted TrueForge
   * mapping. Returns the opaque application session ID, or undefined when
   * session creation cannot proceed.
   */
  private async ensureSession(): Promise<string | undefined> {
    if (this.activeSessionId && this.runtimeSessionIds.has(this.activeSessionId)) {
      return this.activeSessionId
    }
    if (!this.service) {
      logError("Runtime", "Context service not available — cannot create session")
      return undefined
    }
    // Check if activeSessionId is in SQLite and already has a trueforgeSessionId
    if (this.activeSessionId) {
      const existing = this.service.getSession(this.activeSessionId)
      if (existing?.trueforgeSessionId) {
        this.runtimeSessionIds.set(this.activeSessionId, existing.trueforgeSessionId)
        return this.activeSessionId
      }
    }
    try {
      if (!this.pendingAppSessionId) {
        const appId = this.activeSessionId ?? `s-${randomUUID()}`
        if (!this.activeSessionId) {
          await this.service.createSession("Agent Session", appId)
        }
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
   * Explicitly create a new named application session and its TrueForge counterpart.
   */
  public async handleCreateSession(title: string): Promise<string | undefined> {
    return this.enqueueSessionOp(() => this.createSessionInner(title))
  }

  private async createSessionInner(title: string): Promise<string | undefined> {
    const trimmed = title.trim()
    if (!trimmed) {
      this.broadcast({ type: "error", message: "Session title cannot be empty." })
      return undefined
    }
    if (this.sessionOpBlocked("create")) return undefined
    if (!this.service) {
      this.broadcast({ type: "error", message: "Context database is not initialized." })
      return undefined
    }

    const appId = `s-${randomUUID()}`
    try {
      await this.service.createSession(trimmed, appId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logError("Controller", "Failed to create session", { message: msg })
      this.broadcast({ type: "error", message: `Failed to create session: ${msg}` })
      return undefined
    }

    const bound = await this.bindRuntimeSession(appId)
    if (!bound) {
      this.broadcast({
        type: "error",
        message: "Runtime session initialization failed. The application session was saved and can retry.",
      })
    }

    this.activeSessionId = appId
    this.state.setActiveSession(appId)
    this.publishSessionState(appId)
    return appId
  }

  /**
   * Rename an existing application session.
   */
  public async handleRenameSession(sessionId: string, title: string): Promise<void> {
    return this.enqueueSessionOp(() => this.renameSessionInner(sessionId, title))
  }

  private async renameSessionInner(sessionId: string, title: string): Promise<void> {
    const trimmed = title.trim()
    if (!trimmed) {
      this.broadcast({ type: "error", message: "Session title cannot be empty." })
      return
    }
    if (!this.service) {
      this.broadcast({ type: "error", message: "Context database is not initialized." })
      return
    }

    try {
      await this.service.renameSession(sessionId, trimmed)
      const sessions = this.sessionListItems()
      this.broadcast({ type: "sessionsList", activeSessionId: this.activeSessionId ?? sessionId, sessions })
      const snap = this.getContextSnapshotSync()
      if (snap) {
        this.broadcast(snap)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logError("Controller", "Failed to rename session", { sessionId, message: msg })
      this.broadcast({ type: "error", message: `Failed to rename session: ${msg}` })
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
  public async handlePrompt(text: string, attachments?: PromptAttachment[]): Promise<void> {
    logInfo("Prompt", "handlePrompt: " + text.slice(0, 80))
    await this.ensureRuntime().catch(() => {})
    if (!this.runtime) { this.broadcast({ type: "error", message: "Runtime not available." }); return }
    this.state.recordTiming({ submittedAt: Date.now() }); this.state.incrementRequestCount(); this.state.setStage("prompt.submitted")
    this.state.setRunning(true); this.broadcast({ type: "runtimeStatus", status: "running" })
    this.broadcast({ type: "telemetryUpdate", data: this.state.getTelemetryData() })
    this.broadcast({ type: "userMessage", text, attachments, sessionId: this.activeSessionId }); this.state.recordActivity("event", "Prompt submitted")
    let runtimeSid;
    if (this.activeSessionId) runtimeSid = this.runtimeSessionIds.get(this.activeSessionId)
    if (!runtimeSid) {
      this.state.setStage("resolving.session")
      const appSid = await this.ensureSession()
      if (!appSid) { this.state.setStage("failed"); this.state.setRunning(false); this.state.recordTiming({ completedAt: Date.now() }); this.broadcast({ type: "runtimeStatus", status: "idle" }); this.broadcast({ type: "error", message: "Session creation failed." }); return }
      runtimeSid = this.runtimeSessionIds.get(appSid)
    }
    this.state.recordTiming({ sessionResolvedAt: Date.now() }); this.state.setStage("assembling.context")
    let formattedPrompt = text
    try {
      const budget = vscode.workspace.getConfiguration("trueforge").get<number>("contextBudget", 4000)
      let candidates: ContextCandidate[] = []
      try { if (this.activeSessionId && this.service) candidates = (await this.service.listSessionContext(this.activeSessionId)) ?? [] } catch { logWarn("Context", "Failed to list session context", { message: "empty" }) }
      const workspaceFiles = await loadWorkspaceFiles()
      const resolved = await this.resolveAttachments(attachments ?? [])
      const assembly = assembleContext({ candidates, query: text, files: workspaceFiles, budget })
      const st = assembly.selected.reduce((s, x) => s + x.candidate.block.tokenEstimate, 0)
      const rt = assembly.retrieved.reduce((s, x) => s + Math.ceil(x.text.length / 4), 0)
      const at = resolved.reduce((s, x) => s + attachmentTokenEstimate(x.content), 0)
      const msg = { type: "contextAssembly", budget: assembly.budget, usedTokens: st + rt + at, selected: [...assembly.selected.map(s => ({ title: s.candidate.block.title, tokenEstimate: s.candidate.block.tokenEstimate, reason: s.reason })), ...resolved.map(r => ({ title: r.label + " (" + r.path + ")", tokenEstimate: attachmentTokenEstimate(r.content), reason: "attachment" }))], omitted: assembly.omitted.map(o => ({ title: o.candidate.block.title, tokenEstimate: o.candidate.block.tokenEstimate, reason: "budget" })), retrieved: assembly.retrieved.map(r => ({ path: r.path, startLine: r.startLine, endLine: r.endLine, reason: "retrieved" })) }
      this.lastContextAssembly = msg; this.broadcast(msg as any)
      formattedPrompt = formatPromptWithContext(text, assembly, resolved)
    } catch (ctxErr) {
      logError("Context", "Assembly failed", { message: String(ctxErr) })
      this.state.setStage("failed"); this.state.setRunning(false); this.state.recordTiming({ completedAt: Date.now() })
      this.broadcast({ type: "runtimeStatus", status: "idle" }); this.broadcast({ type: "error", message: "Context loading failed: " + String(ctxErr) })
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

  /**
   * True when `filePath` resolves to a path inside any workspace folder,
   * including symlink resolution. Rejects paths outside all workspace roots
   * and symlink escapes that resolve outside the workspace.
   */
  private isPathInWorkspace(filePath: string): boolean {
    const folders = vscode.workspace.workspaceFolders
    if (!folders || folders.length === 0) return false
    try {
      const resolved = realpathSync(filePath)
      return folders.some((f) => {
        const rootResolved = realpathSync(f.uri.fsPath)
        const normalizedRoot = rootResolved.replace(/\\/g, "/").replace(/\/$/, "") + "/"
        const normalizedPath = resolved.replace(/\\/g, "/")
        return normalizedPath.startsWith(normalizedRoot)
      })
    } catch {
      return false
    }
  }

  /**
   * Loads workspace content for user attachments (#file / @symbol picks).
   * Symbol attachments are sliced to their line range; every attachment is
   * bounded to MAX_CHARS_PER_ATTACHMENT so a huge file cannot flood the
   * prompt. Unresolvable paths are logged and skipped, never fatal.
   * Only paths inside the workspace are accepted; outside-workspace and
   * symlink-escape paths are rejected.
   */
  private async resolveAttachments(attachments: PromptAttachment[]): Promise<ResolvedAttachment[]> {
    const resolved: ResolvedAttachment[] = []
    for (const attachment of attachments) {
      try {
        if (!this.isPathInWorkspace(attachment.path)) {
          logWarn("Prompt", `Attachment path outside workspace: ${attachment.path}`)
          continue
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(attachment.path))
        const text = document.getText()
        const startLine = attachment.startLine
        const endLine = attachment.endLine ?? startLine
        const sliced = startLine !== undefined
          ? text.split("\n").slice(startLine - 1, endLine).join("\n")
          : text
        resolved.push({
          type: attachment.type,
          path: attachment.path,
          label: attachment.label,
          startLine,
          endLine,
          content: sliced.slice(0, MAX_CHARS_PER_ATTACHMENT),
        })
      } catch (error) {
        logWarn("Prompt", `Attachment not resolved: ${attachment.path}`, {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return resolved
  }
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
  public async handleContextAction(msg: {
    action: string
    blockId: string
    destinationSessionId?: string
    priority?: any
    scope?: any
    status?: any
    visibility?: any
  }): Promise<void> {
    if (!this.service || !this.activeSessionId) return
    try {
      switch (msg.action) {
        case "store":
          await this.service.store(this.activeSessionId, msg.blockId, msg.visibility ?? "project")
          break
        case "attach":
          await this.service.attach(this.activeSessionId, msg.blockId, msg.scope ?? "task")
          break
        case "move":
          if (!msg.destinationSessionId) throw new Error("Destination session is required for move")
          await this.service.move(this.activeSessionId, msg.destinationSessionId, msg.blockId)
          break
        case "copy":
          if (!msg.destinationSessionId) throw new Error("Destination session is required for copy")
          await this.service.copy(this.activeSessionId, msg.destinationSessionId, msg.blockId)
          break
        case "setPriority":
          await this.service.setPriority(this.activeSessionId, msg.blockId, msg.priority ?? null, true)
          break
        case "setScope":
          if (!msg.scope) throw new Error("Scope is required for setScope")
          await this.service.setScope(this.activeSessionId, msg.blockId, msg.scope)
          break
        case "setStatus":
          if (!msg.status) throw new Error("Status is required for setStatus")
          await this.service.setStatus(this.activeSessionId, msg.blockId, msg.status)
          break
        case "pin":
          await this.service.pin(this.activeSessionId, msg.blockId)
          break
        case "unpin":
          await this.service.unpin(this.activeSessionId, msg.blockId)
          break
        case "lock":
          await this.service.lock(this.activeSessionId, msg.blockId)
          break
        case "unlock":
          await this.service.unlock(this.activeSessionId, msg.blockId)
          break
        case "promote":
          await this.service.setStatus(this.activeSessionId, msg.blockId, "active")
          break
        case "restore":
          await this.service.restore(this.activeSessionId, msg.blockId)
          break
        default:
          logWarn("Controller", "Unknown context action", { action: msg.action })
          return
      }
    } catch (err) {
      logError("Controller", "Context action failed", { action: msg.action, blockId: msg.blockId, message: String(err) })
      this.broadcast({ type: "error", message: err instanceof Error ? err.message : String(err) })
      return
    }
    const snap = this.getContextSnapshotSync()
    if (snap) {
      this.broadcast(snap)
    }
  }

  public async handleSelectSession(sessionId: string): Promise<void> {
    return this.enqueueSessionOp(() => this.selectSessionInner(sessionId))
  }

  private async selectSessionInner(sessionId: string): Promise<void> {
    if (!this.service) return
    if (this.sessionOpBlocked("switch")) return
    const session = this.service.getSession(sessionId)
    if (!session) {
      this.broadcast({ type: "error", message: `Cannot switch to unknown session: ${sessionId}` })
      return
    }
    await this.bindRuntimeSession(sessionId)
    await this.service.touchSession(sessionId)
    this.activeSessionId = sessionId
    this.state.setActiveSession(sessionId)
    this.publishSessionState(sessionId)
  }

  public getContextSnapshotSync(): (ExtensionToWebviewMessage & { type: "contextSnapshot" }) | undefined {
    if (!this.service) return undefined
    try {
      const sessions = this.sessionListItems()
      const activeSessionId = this.activeSessionId ?? sessions[0]?.id ?? ""
      const candidates = activeSessionId ? this.service.listSessionContext(activeSessionId) : []
      const blocks = candidates.map(({ block, membership }) => ({
        id: block.id,
        title: block.title,
        content: block.content,
        sourceType: block.sourceType,
        provenance: block.provenance,
        scope: membership.scope,
        priority: membership.priority,
        status: membership.status,
        position: membership.position,
        pinned: membership.pinned,
        locked: membership.locked,
        tokenEstimate: block.tokenEstimate,
      }))
      const library = this.service.listLibrary().map(({ block, visibility }) => ({
        id: block.id,
        title: block.title,
        visibility,
      }))
      const conflicts = detectConflicts(candidates).map((c) => ({
        key: c.key,
        leftTitle: c.left.block.title,
        rightTitle: c.right.block.title,
      }))
      return {
        type: "contextSnapshot",
        activeSessionId,
        sessions,
        blocks,
        library,
        conflicts,
      }
    } catch (err) {
      logWarn("Controller", "Failed to build context snapshot", { message: String(err) })
      return undefined
    }
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
  /**
   * Monotonic requestId counter for attachment search requests.
   * Incremented on every resolveAttachment call so the webview can
   * discard stale out-of-order responses.
   */
  private attachmentReqId = 0

  public async resolveAttachment(query: string, requestId?: number): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (!root) return
    // Use provided requestId or allocate one for backward compat
    const reqId = requestId ?? ++this.attachmentReqId
    const results: Array<any> = []
    if (query.startsWith("#")) {
      const files = await vscode.workspace.findFiles("**/*" + query.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "*", "**/{node_modules,.git,out,dist,coverage}/**", 10)
      for (const f of files) results.push({ type: "file", path: f.fsPath, label: f.fsPath.replace(/^.*[\\/]/, "") })
    } else if (query.startsWith("@")) {
      const syms = await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", query.slice(1))
      if (syms) for (const s of syms) results.push({ type: "symbol", path: s.location.uri.fsPath, label: s.name, startLine: s.location.range.start.line + 1, endLine: s.location.range.end.line + 1 })
    }
    this.broadcast({ type: "attachmentResolved", query, requestId: reqId, results })
  }

  private resolveAppSessionId(runtimeSessionId?: string): string {
    if (!runtimeSessionId) return this.activeSessionId ?? ""
    for (const [appId, rtId] of this.runtimeSessionIds.entries()) {
      if (rtId === runtimeSessionId) return appId
    }
    return this.activeSessionId ?? ""
  }

  /**
   * Routes streaming agent events from TrueForgeRuntime to the shared state
   * and broadcasts the corresponding ExtensionToWebviewMessage variants.
   * This is the main event loop for the controller.
   */
  private onRuntimeEvent(event: AgentEvent): void {
    const eventSessionId = "sessionId" in event ? (event as any).sessionId : undefined
    const appSessionId = this.resolveAppSessionId(eventSessionId)
    switch (event.type) {
      case "model.message.delta":
        this.state.setLastEventTimestamp(Date.now()); if (!this.state.timing.firstEventAt) this.state.recordTiming({ firstEventAt: Date.now() }); if (!this.state.timing.firstDeltaAt) this.state.recordTiming({ firstDeltaAt: Date.now() }); if (!this.state.timing.firstVisibleTextAt) this.state.recordTiming({ firstVisibleTextAt: Date.now() })
        this.broadcast({ type: "assistantDelta", text: event.text, reasoning: event.reasoning, sessionId: appSessionId }); break
      case "model.message": this.state.setLastEventTimestamp(Date.now()); this.broadcast({ type: "assistantMessage", text: event.text, reasoning: event.reasoning, sessionId: appSessionId }); break
      case "tool.approval_required":
        for (const tc of event.toolCalls) this.pendingApprovals.set(event.threadId + ":" + tc.id, { appSessionId, runtimeSessionId: event.sessionId ?? "", threadId: event.threadId, toolCallId: tc.id })
        this.state.setStage("awaiting.approval"); this.state.recordActivity("tool", "Approval needed", event.toolCalls.map(tc => tc.toolName ?? tc.id).join(", "))
        this.broadcast({ type: "toolApprovalRequired", threadId: event.threadId, toolCalls: event.toolCalls ?? [], sessionId: appSessionId }); break
      case "turn.update": {
        if (event.state.status === "paused") {
          this.broadcast({ type: "turnPaused", status: "paused", threadId: event.threadId ?? undefined })
          this.state.recordActivity("event", "Turn paused")
        }
        break
      }
      case "turn.done": {
        const tds = event.state; this.state.recordTiming({ finalMessageAt: Date.now(), completedAt: Date.now() }); this.state.setActiveTurn(undefined)
        let termOut: { text: string; reasoning?: string } | null = null
        if (tds.status === "done" && (tds as any).output && (tds as any).output.type === "model.message") {
          const out = (tds as any).output; const content = out.content ?? ""
          const txt = typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => ("text" in p ? p.text : "")).join("") : ""
          if (txt) termOut = { text: txt, reasoning: out.reasoningContent }
        }
        if (termOut && termOut.text.length > 0) {
          this.broadcast({ type: "assistantFinalMessage", text: termOut.text, reasoning: termOut.reasoning, sessionId: appSessionId })
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
    try {
      this.database = await ContextDatabase.open({ filePath: vscode.Uri.joinPath(context.globalStorageUri, "context.sqlite").fsPath })
      this.service = new ContextService(this.database)
      this.hydratePersistedSessions()
    } catch (e) {
      logWarn("Context", "Init failed", { message: String(e) })
    }
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

/** Upper bound for content injected per user attachment (#file / @symbol). */
const MAX_CHARS_PER_ATTACHMENT = 2400

async function loadWorkspaceFiles() {
  const maxFiles = 20; const maxChars = 4000; const maxBytes = 80000
  const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,out,dist,coverage}/**", maxFiles)
  if (!uris.length) return []
  uris.sort((a, b) => a.fsPath.localeCompare(b.fsPath))
  const results = []; let total = 0
  for (const u of uris) {
    if (total >= maxBytes) break
    try {
      const doc = await vscode.workspace.openTextDocument(u); const text = doc.getText()
      if (text.length > maxChars) continue
      const bytes = Buffer.byteLength(text, "utf-8")
      if (bytes > maxBytes - total) continue
      results.push({ path: vscode.workspace.asRelativePath(u, false), content: text })
      total += bytes
    } catch {}
  }
  return results
}
