import * as vscode from "vscode"
import type { WebviewToExtensionMessage } from "../shared/messages"
import { ContextService } from "../context/ContextService"
import { ContextDatabase } from "../context/db/Database"
import { detectConflicts } from "../context/ContextConflicts"
import { assembleContext } from "../context/ContextAssembler"
import { TrueForgeRuntime } from "../runtime/TrueForgeRuntime"
import type { AgentEvent } from "../runtime/AgentRuntime"
import { createVscodeDiffReviewService } from "../edits/VscodeDiffReview"
import type { LocalMcpServer } from "../mcp/McpServer"

export class ContextViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "trueforge.contextView"
  private database?: ContextDatabase
  private service?: ContextService
  private activeSessionId?: string
  private webview?: vscode.Webview
  private runtime?: TrueForgeRuntime
  private readonly runtimeSessionIds = new Map<string, string>()
  private readonly pendingApprovals = new Map<string, { appSessionId: string; runtimeSessionId: string; threadId: string; toolCallId: string }>()

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalStorageUri: vscode.Uri,
    private readonly getMcpServer?: () => LocalMcpServer | undefined,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    }
    this.webview = webviewView.webview
    webviewView.webview.html = this.getHtml(webviewView.webview)
    webviewView.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
      if (message.type === "ready") {
        await this.initialize()
        await this.postSnapshot()
        await this.initializeRuntime()
        return
      }
      if (message.type === "sendPrompt") {
        await this.handlePrompt(message.text)
        return
      }
      if (message.type === "cancelTurn") {
        await this.handleCancel()
        return
      }
      if (message.type === "toolApproval") {
        await this.handleToolApproval(message)
        return
      }
      if (message.type === "reviewDiff") {
        await this.handleReviewDiff(message.proposalId, message.hunkId)
        return
      }
      if (message.type === "setMode") {
        this.runtime?.setMode(message.mode)
        return
      }
      if (message.type === "selectSession") {
        this.activeSessionId = message.sessionId
        await this.ensureRuntimeSession()
        await this.webview?.postMessage({ type: "sessionChanged", sessionId: message.sessionId })
        await this.postSnapshot()
        return
      }

      if (message.type === "contextAction") {
        await this.handleContextAction(message)
      }
    })
  }

  private async initializeRuntime(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("trueforge")
    const agentName = configuration.get<string>("agentName", "").trim()
    if (!agentName) {
      await this.webview?.postMessage({ type: "runtimeConnection", state: "disconnected" })
      await this.webview?.postMessage({ type: "runtimeStatus", status: "disconnected" })
      return
    }
    if (this.runtime) {
      return
    }
    try {
      this.runtime = await TrueForgeRuntime.create({
        baseUrl: configuration.get<string>("baseUrl", "http://localhost:8790"),
        agentName,
      })
      this.runtime.onEvent((event) => {
        void this.handleRuntimeEvent(event)
      })
      await this.ensureRuntimeSession()
      await this.webview?.postMessage({ type: "runtimeConnection", state: "connected" })
      await this.webview?.postMessage({ type: "runtimeStatus", status: "idle" })
    } catch (error) {
      await this.webview?.postMessage({ type: "runtimeConnection", state: "degraded" })
      await this.webview?.postMessage({ type: "runtimeStatus", status: "disconnected" })
      await this.webview?.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }

  private async handlePrompt(text: string): Promise<void> {
    const prompt = text.trim()
    if (!prompt) {
      return
    }
    await this.ensureRuntimeSession()
    const runtimeSessionId = this.activeSessionId ? this.runtimeSessionIds.get(this.activeSessionId) : undefined
    if (!this.runtime || !runtimeSessionId) {
      await this.webview?.postMessage({
        type: "error",
        message: "No TrueForge agent is configured. Set trueforge.agentName in VS Code settings.",
      })
      return
    }
    try {
      const assembly = await this.buildPromptContext(prompt)
      await this.webview?.postMessage({
        type: "contextAssembly",
        budget: assembly.budget,
        usedTokens:
          assembly.selected.reduce((sum, item) => sum + item.candidate.block.tokenEstimate, 0) +
          assembly.retrieved.reduce((sum, item) => sum + Math.ceil(item.text.length / 4), 0),
        selected: assembly.selected.map(({ candidate, reason }) => ({
          title: candidate.block.title,
          tokenEstimate: candidate.block.tokenEstimate,
          reason,
        })),
        omitted: assembly.omitted.map(({ candidate, reason }) => ({
          title: candidate.block.title,
          tokenEstimate: candidate.block.tokenEstimate,
          reason,
        })),
        retrieved: assembly.retrieved.map(({ path, startLine, endLine, reason }) => ({
          path,
          startLine,
          endLine,
          reason,
        })),
      })
      await this.webview?.postMessage({ type: "userMessage", text: prompt })
      await this.webview?.postMessage({ type: "runtimeStatus", status: "running" })
      await this.runtime.sendTurn(runtimeSessionId, formatPromptWithContext(prompt, assembly))
    } catch (error) {
      await this.webview?.postMessage({ type: "runtimeStatus", status: "idle" })
      await this.webview?.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }

  private async buildPromptContext(prompt: string) {
    if (!this.service || !this.activeSessionId) {
      return assembleContext({ candidates: [], query: prompt, budget: 4000 })
    }
    const workspaceFiles = await loadWorkspaceFiles()
    return assembleContext({
      candidates: this.service.listSessionContext(this.activeSessionId),
      query: prompt,
      files: workspaceFiles,
      budget: vscode.workspace.getConfiguration("trueforge").get<number>("contextBudget", 4000),
      retrieval: {
        maxFiles: 12,
        maxCharsPerFile: 2400,
        maxResults: 12,
      },
    })
  }

  private async handleCancel(): Promise<void> {
    const runtimeSessionId = this.activeSessionId ? this.runtimeSessionIds.get(this.activeSessionId) : undefined
    if (!this.runtime || !runtimeSessionId) {
      return
    }
    try {
      await this.runtime.cancel(runtimeSessionId)
      await this.webview?.postMessage({ type: "runtimeStatus", status: "idle" })
    } catch (error) {
      await this.webview?.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }

  private async handleToolApproval(
    message: Extract<WebviewToExtensionMessage, { type: "toolApproval" }>,
  ): Promise<void> {
    const pending = this.pendingApprovals.get(message.toolCallId)
    const runtimeSessionId = pending?.runtimeSessionId ?? (this.activeSessionId ? this.runtimeSessionIds.get(this.activeSessionId) : undefined)
    if (!this.runtime || !runtimeSessionId) {
      await this.webview?.postMessage({
        type: "error",
        message: "Cannot approve a tool call before the TrueForge session is connected.",
      })
      return
    }
    try {
      await this.runtime.respondToApproval(
        runtimeSessionId,
        message.threadId,
        message.toolCallId,
        message.decision === "allow" ? { status: "allow" } : { status: "deny", reason: "Denied in VS Code." },
      )
      this.pendingApprovals.delete(message.toolCallId)
    } catch (error) {
      await this.webview?.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }

  private async handleReviewDiff(proposalId: string, hunkId?: string): Promise<void> {
    const server = this.getMcpServer?.()
    if (!server) {
      await vscode.window.showErrorMessage("Local MCP server is not active.")
      return
    }
    const proposal = server.getWorkspaceTools().getProposal(proposalId)
    if (!proposal) {
      await vscode.window.showErrorMessage(`Proposal not found: ${proposalId}`)
      return
    }
    try {
      const diffReview = createVscodeDiffReviewService()
      await diffReview.open(proposal.editProposal)
    } catch (error) {
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }

  private async handleRuntimeEvent(event: AgentEvent): Promise<void> {
    const eventSessionId = "sessionId" in event ? event.sessionId : undefined
    let eventAppSessionId: string | undefined
    if (eventSessionId) {
      for (const [appId, rId] of this.runtimeSessionIds.entries()) {
        if (rId === eventSessionId) {
          eventAppSessionId = appId
          break
        }
      }
    }

    if (event.type === "connection.changed") {
      await this.webview?.postMessage({ type: "runtimeConnection", state: event.state })
    } else if (event.type === "model.message.delta") {
      if (!eventAppSessionId || eventAppSessionId === this.activeSessionId) {
        await this.webview?.postMessage({ type: "assistantDelta", text: event.text })
      }
    } else if (event.type === "model.message") {
      if (!eventAppSessionId || eventAppSessionId === this.activeSessionId) {
        await this.webview?.postMessage({ type: "assistantMessage", text: event.text })
      }
    } else if (event.type === "tool.approval_required") {
      for (const tc of event.toolCalls) {
        this.pendingApprovals.set(tc.id, {
          appSessionId: eventAppSessionId ?? this.activeSessionId ?? "default",
          runtimeSessionId: eventSessionId ?? (this.activeSessionId ? this.runtimeSessionIds.get(this.activeSessionId) ?? "" : ""),
          threadId: event.threadId,
          toolCallId: tc.id,
        })
      }
      await this.webview?.postMessage({
        type: "toolApprovalRequired",
        threadId: event.threadId,
        sessionId: eventAppSessionId,
        toolCalls: event.toolCalls.map((tc) => ({
          id: tc.id,
          sourceEventId: tc.sourceEventId,
          toolName: tc.toolName,
          arguments: tc.arguments,
        })),
      })
    } else if (event.type === "turn.done") {
      const state = (event as any).state
      // Extract assistant text from terminal output — this fixes the case where no deltas were streamed but final output exists
      function extractOutput(): { text: string; reasoning?: string } | null {
        if (state.status !== "done") return null
        const out = state.output
        if (!out || out.type !== "model.message") return null
        const content = out.content ?? ""
        let txt = typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => ("text" in p ? p.text : "")).join("") : ""
        return { text: txt, reasoning: out.reasoningContent }
      }
      const termOut = extractOutput()
      if (!eventAppSessionId || eventAppSessionId === this.activeSessionId) {
        if (termOut && termOut.text.length > 0) {
          // Terminal has output - send through assistant message pipeline even if no deltas arrived
          await this.webview?.postMessage({ type: "assistantFinalMessage", text: termOut.text, reasoning: termOut.reasoning })
        } else if (state.status === "error") {
          const errMsg = state.message || "Unknown error during turn."
          await this.webview?.postMessage({ type: "error", message: errMsg })
        } else if (state.status === "cancelled") {
          // Show cancellation reason without fabricating failure
        } else {
          // Done but no output - explicit diagnostic, not silent failure
          await this.webview?.postMessage({ type: "runtimeStatus", status: "idle" })
        }
      }
    } else if (event.type === "error") {
      await this.webview?.postMessage({ type: "error", message: event.message })
    }
  }

  private async initialize(): Promise<void> {
    if (this.service) {
      return
    }
    this.database = await ContextDatabase.open({
      filePath: vscode.Uri.joinPath(this.globalStorageUri, "context.sqlite").fsPath,
    })
    this.service = new ContextService(this.database)
    const sessions = this.service.listSessions()
    if (sessions.length === 0) {
      const now = new Date().toISOString()
      this.database.run(
        "INSERT INTO app_sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ["default", "Current session", now, now],
      )
      await this.database.save()
    }
    this.activeSessionId = this.activeSessionId ?? this.service.listSessions()[0]?.id
  }

  private async ensureRuntimeSession(): Promise<void> {
    if (!this.runtime || !this.service || !this.activeSessionId) {
      return
    }
    const mapped = this.service.listSessions().find((session) => session.id === this.activeSessionId)?.trueforgeSessionId
    if (mapped) {
      this.runtimeSessionIds.set(this.activeSessionId, mapped)
      return
    }
    const session = await this.runtime.createSession()
    this.runtimeSessionIds.set(this.activeSessionId, session.id)
    await this.service.setTrueForgeSessionId(this.activeSessionId, session.id)
  }

  private async handleContextAction(
    message: Extract<WebviewToExtensionMessage, { type: "contextAction" }>,
  ): Promise<void> {
    try {
      await this.initialize()
      if (!this.service || !this.activeSessionId) {
        throw new Error("Context Manager is not initialized.")
      }
      if (message.action === "store") {
        await this.service.store(this.activeSessionId, message.blockId, "project")
      } else if (message.action === "attach") {
        await this.service.attach(this.activeSessionId, message.blockId, "task")
      } else if (message.action === "move" || message.action === "copy") {
        if (!message.destinationSessionId) {
          throw new Error("Choose a destination session before moving or copying context.")
        }
        if (message.action === "move") {
          await this.service.move(this.activeSessionId, message.destinationSessionId, message.blockId)
        } else {
          await this.service.copy(this.activeSessionId, message.destinationSessionId, message.blockId)
        }
      }
      await this.postSnapshot()
    } catch (error) {
      await this.webview?.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }

  private async postSnapshot(): Promise<void> {
    if (!this.service || !this.activeSessionId) {
      return
    }
    const blocks = this.service.listSessionContext(this.activeSessionId)
    const sessions = this.service.listSessions()
    const library = this.service.listLibrary()
    const conflicts = detectConflicts(blocks)
    await this.webview?.postMessage({
      type: "contextSnapshot",
      activeSessionId: this.activeSessionId,
      sessions: sessions.map(({ id, title }) => ({ id, title })),
      blocks: blocks.map(({ block, membership }) => ({
        id: block.id,
        title: block.title,
        content: block.content,
        sourceType: block.sourceType,
        scope: membership.scope,
        priority: membership.priority,
        status: membership.status,
        position: membership.position,
        pinned: membership.pinned,
        locked: membership.locked,
        tokenEstimate: block.tokenEstimate,
      })),
      library: library.map(({ block, visibility }) => ({ id: block.id, title: block.title, visibility })),
      conflicts: conflicts.map(({ key, left, right }) => ({
        key,
        leftTitle: left.block.title,
        rightTitle: right.block.title,
      })),
    })
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce()
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "out", "webview.js"))
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TrueForge Context Agent</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let value = ""
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  }
  return value
}

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

async function loadWorkspaceFiles(): Promise<Array<{ path: string; content: string }>> {
  const files = await vscode.workspace.findFiles(
    "**/*",
    "**/{node_modules,.git,out,dist,coverage}/**",
  )
  if (!vscode.workspace.workspaceFolders?.length) {
    return []
  }

  const results: Array<{ path: string; content: string }> = []
  for (const file of files.sort((left, right) => left.fsPath.localeCompare(right.fsPath))) {
    try {
      const document = await vscode.workspace.openTextDocument(file)
      if (document.getText().length <= 40_000) {
        results.push({
          path: vscode.workspace.asRelativePath(file, false),
          content: document.getText(),
        })
      }
    } catch (error) {
      if (error instanceof vscode.FileSystemError) {
        continue
      }
      throw error
    }
  }
  return results
}
