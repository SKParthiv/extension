import * as vscode from "vscode"
import { DiffReviewService, type DiffReviewApi } from "./DiffReview"

export function createVscodeDiffReviewService(): DiffReviewService {
  const api: DiffReviewApi = {
    openTextDocument: (options) => vscode.workspace.openTextDocument(options),
    executeCommand: (command, original, proposed, title) =>
      vscode.commands.executeCommand(command, vscode.Uri.parse(`${original.scheme}:${original.path}`), vscode.Uri.parse(`${proposed.scheme}:${proposed.path}`), title),
  }
  return new DiffReviewService(api)
}

