import * as vscode from "vscode"
import type { WebviewToExtensionMessage } from "../shared/messages"
import { NotTheLeastController } from "../runtime/NotTheLeastController"

export class GenericViewProvider implements vscode.WebviewViewProvider {
  public constructor(
    private readonly extensionUri: vscode.Uri,
    public readonly viewId: string,
    private readonly controller: NotTheLeastController,
    private viewDisposable?: vscode.Disposable,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] }
    const viewName = this.viewId.split(".").pop() ?? this.viewId
    webviewView.webview.html = this.getHtml(webviewView.webview, viewName)
    // Register with controller and get a disposable tied to this view's lifecycle
    this.viewDisposable?.dispose()
    this.viewDisposable = this.controller.registerView(this.viewId, (msg) => {
      void webviewView.webview.postMessage(msg)
    })
    // Send an initial snapshot to this view only
    this.controller.postSnapshot(this.viewId)

    webviewView.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
      if (message.type === "ready") { return } // snapshot already sent in resolveWebviewView
      if (message.type === "sendPrompt") { await this.controller.handlePrompt(message.text, message.attachments); return }
      if (message.type === "cancelTurn") { await this.controller.handleCancel(); return }
      if (message.type === "toolApproval") { await this.controller.handleToolApproval(message); return }
      if (message.type === "contextAction") { await this.controller.handleContextAction(message); return }
      if (message.type === "resolveAttachment") { await this.controller.resolveAttachment(message.query); return }
      if (message.type === "exportDiagnostics") { this.controller.handleExportDiagnostics(); return }
      if (message.type === "setMode") { return }
      if (message.type === "selectSession") { return }
      if (message.type === "openPanel") { return }
      if (message.type === "inlineEditRequest") { return }
      if (message.type === "reviewDiff") { return }
    })
  }

  private getHtml(webview: vscode.Webview, viewName: string): string {
    const nonce = createNonce()
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "out", "webview.js"))
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NotTheLeast - ${viewName}</title>
</head>
<body>
  <div id="root" data-view="${viewName}"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }

  /** Clean up the controller registration when VS Code disposes this view. */
  public dispose(): void { this.viewDisposable?.dispose() }
}

function createNonce(): string {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let v = ""
  for (let i = 0; i < 32; i++) v += a.charAt(Math.floor(Math.random() * a.length))
  return v
}