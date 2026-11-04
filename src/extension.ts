import * as vscode from "vscode"
import { ContextViewProvider } from "./webview/ContextViewProvider"

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ContextViewProvider(context.extensionUri)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ContextViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("agent.openPanel", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.trueforge")
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("agent.inlineEdit", async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || editor.selection.isEmpty) {
        await vscode.window.showInformationMessage("Select code before running TrueForge inline edit.")
        return
      }
      await vscode.window.showInformationMessage("Inline edit runtime is not connected yet.")
    }),
  )
}

export function deactivate(): void {}

