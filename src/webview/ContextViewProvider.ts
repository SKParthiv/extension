import * as vscode from "vscode"
import type { WebviewToExtensionMessage } from "../shared/messages"

export class ContextViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "trueforge.contextView"

  public constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    }
    webviewView.webview.html = this.getHtml(webviewView.webview)
    webviewView.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      if (message.type === "ready") {
        void webviewView.webview.postMessage({ type: "runtimeStatus", status: "disconnected" })
      }
    })
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce()
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TrueForge Context Agent</title>
</head>
<body>
  <main>
    <h1>TrueForge</h1>
    <p>Agent panel is ready.</p>
    <p id="status">Runtime: disconnected</p>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    window.addEventListener("message", event => {
      if (event.data?.type === "runtimeStatus") {
        document.getElementById("status").textContent = "Runtime: " + event.data.status;
      }
    });
    vscode.postMessage({ type: "ready" });
  </script>
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

