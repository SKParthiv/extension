/**
 * @file
 * VS Code extension entry point (activate / deactivate).
 *
 * == Startup sequence (activate) ==
 * 1. Create a LocalMcpServer for MCP tool registration.
 * 2. Create the NotTheLeastController (runtime, context DB, GPU poller).
 * 3. Register webview views (GenericViewProvider, ContextViewProvider).
 * 4. Register commands (inline edit, undo edit, code-action).
 * 5. Register the MCP server as a VS Code language model tool provider.
 *
 * == Shutdown sequence (deactivate) ==
 * 1. Stop the MCP HTTP server.
 * 2. Dispose the controller (clears GPU poller, etc.).
 *
 * Owned by: VS Code extension host (not user-configurable).
 */

import * as vscode from "vscode"
import { randomBytes } from "node:crypto"
import * as path from "node:path"
import { TrueForgeRuntime } from "./runtime/TrueForgeRuntime"
import { NotTheLeastController } from "./runtime/NotTheLeastController"
import { GenericViewProvider } from "./webview/GenericViewProvider"
import { InlineEditService, createInlineEditProposal } from "./edits/InlineEditFlow"
import { SafeUndoService } from "./edits/SafeUndo"
import { createVscodeDiffReviewService } from "./edits/VscodeDiffReview"
import { approveHunk, applyApprovedHunks } from "./edits/EditProposal"
import { LocalMcpServer } from "./mcp/McpServer"

/** Safe undo service shared across inline edit and MCP apply-hunk flows. */
const undo = new SafeUndoService()
/** The in-process loopback MCP server for TrueForge agent tool calls. */
let localMcpServer: LocalMcpServer | undefined
/** Cached MCP server connection info (host, port, URL, bearer token). */
let localMcpInfo: Awaited<ReturnType<LocalMcpServer["start"]>> | undefined
/** Central controller — owns runtime, context DB, state and webview broadcasts. */
let controller: NotTheLeastController | undefined

/**
 * VS Code extension activation entry point.
 * Sets up MCP server, runtime controller, webview views, commands and
 * MCP tool provider. Called once by VS Code on extension startup.
 */
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

  // ── NotTheLeast controller (owns runtime, SharedState, logging, GPU telemetry) ──
  controller = new NotTheLeastController()
  await controller.initialize(context)

  // ── Register all five NotTheLeast views ──
  const viewIds = ["nottheleast.chat", "nottheleast.activity", "nottheleast.tools", "nottheleast.diagnostics", "nottheleast.context"]

  for (const vid of viewIds) {
    const p = new GenericViewProvider(context.extensionUri, vid, controller)
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(vid, p, { webviewOptions: { retainContextWhenHidden: true } }),
    )
  }
  // Connect broadcast to view providers - the ready message in GenericViewProvider registers the view
  void controller.initializeRuntime()

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
    vscode.commands.registerCommand("agent.copyDiagnostics", async () => {
      await controller?.handleExportDiagnostics()
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

/**
 * VS Code extension deactivation entry point.
 * Stops the MCP server and disposes the controller.
 */
export async function deactivate(): Promise<void> {
  await localMcpServer?.stop()
  localMcpServer = undefined
  localMcpInfo = undefined
  controller?.dispose()
  controller = undefined
}

/**
 * Sends a "rewrite the selected code" instruction to the model and
 * extracts the replacement text from the first fenced code block in
 * the response.
 * @throws If the model returns an empty replacement.
 */
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

/**
 * Creates an {@link UndoWorkspace} adapter backed by VS Code text documents.
 * Used by the SafeUndoService to read current and write restored content.
 */
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
