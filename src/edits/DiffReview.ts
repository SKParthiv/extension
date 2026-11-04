import type { EditProposal } from "./EditProposal"

export interface DiffUri {
  scheme: string
  path: string
}

export interface DiffReviewApi {
  openTextDocument(options: { content: string; language?: string }): PromiseLike<{ uri: DiffUri }>
  executeCommand(command: "vscode.diff", original: DiffUri, proposed: DiffUri, title: string): PromiseLike<unknown>
}

export class DiffReviewService {
  public constructor(private readonly api: DiffReviewApi) {}

  public async open(proposal: EditProposal, language?: string): Promise<void> {
    if (proposal.hunks.length === 0) {
      throw new Error("Cannot review an empty edit proposal.")
    }
    const [original, proposed] = await Promise.all([
      this.api.openTextDocument({ content: proposal.originalText, ...(language ? { language } : {}) }),
      this.api.openTextDocument({ content: proposal.proposedText, ...(language ? { language } : {}) }),
    ])
    await this.api.executeCommand(
      "vscode.diff",
      original.uri,
      proposed.uri,
      `TrueForge review: ${proposal.filePath}`,
    )
  }
}
