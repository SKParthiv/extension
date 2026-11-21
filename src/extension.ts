import * as vscode from "vscode"
import { randomBytes } from "node:crypto"
import * as path from "node:path"
import { ContextViewProvider } from "./webview/ContextViewProvider"
import { TrueForgeRuntime } from "./runtime/TrueForgeRuntime"
import { InlineEditService, createInlineEditProposal } from "./edits/InlineEditFlow"
import { SafeUndoService } from "./edits/SafeUndo"
import { createVscodeDiffReviewService } from "./edits/VscodeDiffReview"
import { approveHunk, applyApprovedHunks } from "./edits/EditProposal"
import { LocalMcpServer } from "./mcp/McpServer"

const undo = new SafeUndoService()
let localMcpServer: LocalMcpServer | undefined
let localMcpInfo: Awaited<ReturnType<LocalMcpServer["start"]>> | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!workspaceRoot) {
    await vscode.window.showErrorMessage("TrueForge requires an open workspace before the MCP server can start.")
    return
  }
  const configuration = vscode.workspace.getConfiguration("trueforge")
  const tokenKey = "trueforge.mcpBearerToken"
  let token = await context.secrets.get(tokenKey)
  if (!token) {
    token = randomBytes(32).toString("hex")
    await context.secrets.store(tokenKey, token)
  }
  localMcpServer = new LocalMcpServer({
    workspaceRoot,
    port: configuration.get<number>("mcpPort", 8765),
    token,
    symbolProvider: async (relativePath?: string, query?: string) => {
      if (relativePath) {
        const uri = vscode.Uri.file(path.join(workspaceRoot, relativePath))
        const docSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          "vscode.executeDocumentSymbolProvider",
          uri,
        )
        return { path: relativePath, symbols: docSymbols ?? [] }
      }
      const wsSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        query ?? "",
      )
      return { query: query ?? "", symbols: wsSymbols ?? [] }
    },
    applyHunk: async (proposal, hunkId) => {
      const fullPath = path.join(workspaceRoot, proposal.path)
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath))
      const beforeText = document.getText()
      const afterText = applyApprovedHunks(proposal.editProposal)

      if (beforeText === afterText) {
        return { proposalId: proposal.id, hunkId, path: proposal.path, applied: true, noop: true }
      }

      const edit = new vscode.WorkspaceEdit()
      edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(0), document.positionAt(beforeText.length)),
        afterText,
      )
      if (!(await vscode.workspace.applyEdit(edit))) {
        throw new Error(`VS Code rejected approved hunk ${hunkId} for ${proposal.path}.`)
      }
      await document.save()

      undo.recordAppliedEdit({
        id: `${proposal.path}:${hunkId}:${Date.now()}`,
        filePath: fullPath,
        beforeText,
        afterText,
      })

      return { proposalId: proposal.id, hunkId, path: proposal.path, applied: true }
    },
  })
  try {
    localMcpInfo = await localMcpServer.start()
  } catch (error) {
    localMcpServer = undefined
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
  }

  const provider = new ContextViewProvider(context.extensionUri, context.globalStorageUri, () => localMcpServer)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ContextViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("agent.copyMcpCredentials", async () => {
      if (!localMcpInfo) {
        await vscode.window.showErrorMessage("The local TrueForge MCP server is not running.")
        return
      }
      await vscode.env.clipboard.writeText(JSON.stringify({ url: localMcpInfo.url, token: localMcpInfo.token }))
      await vscode.window.showInformationMessage("TrueForge MCP URL and bearer token copied to the clipboard.")
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
              await document.save()
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

  context.subscriptions.push(
    vscode.commands.registerCommand("agent.undoEdit", async () => {
      const records = undo.listPending()
      if (records.length === 0) {
        await vscode.window.showInformationMessage("There are no TrueForge edits available to undo.")
        return
      }

      const selected = await vscode.window.showQuickPick(
        records.map((record) => ({
          label: record.filePath,
          description: "Restore the file to its pre-edit contents",
          recordId: record.id,
        })),
        {
          placeHolder: "Choose an approved TrueForge edit to undo",
          ignoreFocusOut: true,
        },
      )
      if (!selected) {
        return
      }

      try {
        const result = await undo.undo(selected.recordId, createUndoWorkspace())
        await vscode.window.showInformationMessage(`TrueForge edit undone: ${result.filePath}`)
      } catch (error) {
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
      }
    }),
  )
}

export async function deactivate(): Promise<void> {
  await localMcpServer?.stop()
  localMcpServer = undefined
  localMcpInfo = undefined
}

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

function createUndoWorkspace() {
  return {
    readText: async (filePath: string) => (await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))).getText(),
    writeText: async (filePath: string, text: string) => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
      const edit = new vscode.WorkspaceEdit()
      edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text)
      if (!(await vscode.workspace.applyEdit(edit))) {
        throw new Error(`VS Code rejected the undo for ${filePath}.`)
      }
    },
  }
}
