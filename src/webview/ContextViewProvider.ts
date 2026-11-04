import * as vscode from "vscode"
import type { WebviewToExtensionMessage } from "../shared/messages"
import { ContextService } from "../context/ContextService"
import { ContextDatabase } from "../context/db/Database"

export class ContextViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "trueforge.contextView"
  private database?: ContextDatabase
  private service?: ContextService
  private activeSessionId?: string
  private webview?: vscode.Webview

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalStorageUri: vscode.Uri,
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
        await webviewView.webview.postMessage({ type: "runtimeStatus", status: "idle" })
        return
      }
      if (message.type === "selectSession") {
        this.activeSessionId = message.sessionId
        await this.postSnapshot()
        return
      }
      if (message.type === "contextAction") {
        await this.handleContextAction(message)
      }
    })
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
