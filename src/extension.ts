import * as vscode from "vscode"
import { ContextViewProvider } from "./webview/ContextViewProvider"
import { TrueForgeRuntime } from "./runtime/TrueForgeRuntime"
import { InlineEditService, createInlineEditProposal } from "./edits/InlineEditFlow"
import { SafeUndoService } from "./edits/SafeUndo"
import { createVscodeDiffReviewService } from "./edits/VscodeDiffReview"
import { approveHunk } from "./edits/EditProposal"

const undo = new SafeUndoService()

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ContextViewProvider(context.extensionUri, context.globalStorageUri)
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
      const instruction = await vscode.window.showInputBox({
        prompt: "Describe the inline edit",
        placeHolder: "e.g. Rename this variable to make its purpose clearer",
        ignoreFocusOut: true,
      })
      if (!instruction?.trim()) {
        return
      }

      try {
        const configuration = vscode.workspace.getConfiguration("trueforge")
        const agentName = configuration.get<string>("agentName", "").trim()
        if (!agentName) {
          throw new Error("Set trueforge.agentName before running an inline edit.")
        }
        const runtime = await TrueForgeRuntime.create({
          baseUrl: configuration.get<string>("baseUrl", "http://localhost:8790"),
          agentName,
        })
        const session = await runtime.createSession()
        const replacement = await requestReplacement(runtime, session.id, editor.document.getText(editor.selection), instruction)
        const proposal = createInlineEditProposal({
          filePath: editor.document.uri.fsPath,
          documentText: editor.document.getText(),
          selectionStart: editor.document.offsetAt(editor.selection.start),
          selectionEnd: editor.document.offsetAt(editor.selection.end),
          replacementText: replacement,
        })
        const service = new InlineEditService(
          {
            readText: async (filePath) => (await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))).getText(),
            writeText: async (filePath, text) => {
              const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
              const edit = new vscode.WorkspaceEdit()
              edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text)
              if (!(await vscode.workspace.applyEdit(edit))) {
                throw new Error(`VS Code rejected the edit for ${filePath}.`)
              }
            },
          },
          createVscodeDiffReviewService(),
          undo,
        )
        await service.reviewProposal(proposal, editor.document.languageId)
        for (const hunk of proposal.hunks) {
          const decision = await vscode.window.showQuickPick(["Accept hunk", "Reject hunk"], {
            placeHolder: `Review hunk ${hunk.originalStart}`,
            ignoreFocusOut: true,
          })
          if (decision === "Accept hunk") {
            const approved = approveHunk(proposal, hunk.id)
            proposal.hunks = approved.hunks
          }
        }
        await service.applyApprovedProposal(proposal)
        await vscode.window.showInformationMessage("TrueForge inline edit applied. Safe undo is available in this session.")
      } catch (error) {
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
      }
    }),
  )
}

export function deactivate(): void {}

async function requestReplacement(
  runtime: TrueForgeRuntime,
  sessionId: string,
  selectedText: string,
  instruction: string,
): Promise<string> {
  let response = ""
  const listener = runtime.onEvent((event) => {
    if (event.type === "model.message.delta") {
      response += event.text
    } else if (event.type === "model.message" && !response) {
      response = event.text
    }
  })
  try {
    await runtime.sendTurn(
      sessionId,
      `Rewrite only the selected code according to this instruction: ${instruction}\nReturn only the replacement code inside one fenced code block.\n\nSelected code:\n\`\`\`\n${selectedText}\n\`\`\``,
    )
  } finally {
    listener.dispose()
  }
  const fenced = response.match(/```[^\n]*\n([\s\S]*?)```/)
  const replacement = (fenced?.[1] ?? response).trimEnd()
  if (!replacement) {
    throw new Error("TrueForge returned an empty inline edit.")
  }
  return replacement
}
