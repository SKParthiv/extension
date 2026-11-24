import {
  applyApprovedHunks,
  approveHunk,
  computeHash,
  createEditProposal,
  type EditProposal,
} from "./EditProposal"
import { SafeUndoService } from "./SafeUndo"

export interface InlineEditWorkspace {
  readText(filePath: string): Promise<string>
  writeText(filePath: string, text: string): Promise<void>
}

export interface InlineEditReview {
  open(proposal: EditProposal, language?: string): Promise<void>
}

export interface InlineEditRequest {
  filePath: string
  documentText: string
  selectionStart: number
  selectionEnd: number
  replacementText: string
}

export class InlineEditConflictError extends Error {
  public constructor(public readonly filePath: string) {
    super(`Cannot apply inline edit: ${filePath} changed after the proposal was created.`)
    this.name = "InlineEditConflictError"
  }
}

export function createInlineEditProposal(request: InlineEditRequest): EditProposal {
  if (request.selectionStart < 0 || request.selectionEnd < request.selectionStart) {
    throw new Error("Inline edit selection range is invalid.")
  }
  if (request.selectionEnd > request.documentText.length) {
    throw new Error("Inline edit selection exceeds the document length.")
  }
  const proposedText =
    request.documentText.slice(0, request.selectionStart) +
    request.replacementText +
    request.documentText.slice(request.selectionEnd)
  return createEditProposal(request.filePath, request.documentText, proposedText)
}

export class InlineEditService {
  public constructor(
    private readonly workspace: InlineEditWorkspace,
    private readonly review: InlineEditReview,
    private readonly undo: SafeUndoService,
  ) {}

  public async reviewProposal(proposal: EditProposal, language?: string): Promise<void> {
    await this.review.open(proposal, language)
  }

  public async applyApprovedProposal(proposal: EditProposal): Promise<string> {
    const currentText = await this.workspace.readText(proposal.filePath)
    const currentHash = computeHash(currentText)
    const expectedHash = proposal.expectedHash ?? proposal.originalHash
    if (currentHash !== expectedHash || currentText !== (proposal.expectedText ?? proposal.originalText)) {
      throw new InlineEditConflictError(proposal.filePath)
    }

    const afterText = applyApprovedHunks(proposal)
    if (afterText === proposal.originalText) {
      throw new Error("Cannot apply an inline edit without an approved change.")
    }

    await this.workspace.writeText(proposal.filePath, afterText)
    proposal.expectedText = afterText
    proposal.expectedHash = computeHash(afterText)
    this.undo.recordAppliedEdit({
      id: createUndoId(proposal),
      filePath: proposal.filePath,
      beforeText: currentText,
      afterText,
    })
    return afterText
  }

  public async applyApprovedHunk(proposal: EditProposal, hunkId: string): Promise<string> {
    const currentText = await this.workspace.readText(proposal.filePath)
    const currentHash = computeHash(currentText)
    const expectedHash = proposal.expectedHash ?? proposal.originalHash
    if (currentHash !== expectedHash || currentText !== (proposal.expectedText ?? proposal.originalText)) {
      throw new InlineEditConflictError(proposal.filePath)
    }

    const approvedProposal = approveHunk(proposal, hunkId)
    const afterText = applyApprovedHunks(approvedProposal)
    if (afterText === currentText) {
      return currentText
    }

    await this.workspace.writeText(proposal.filePath, afterText)
    proposal.expectedText = afterText
    proposal.expectedHash = computeHash(afterText)
    proposal.hunks = approvedProposal.hunks
    this.undo.recordAppliedEdit({
      id: `${createUndoId(proposal)}:${hunkId}`,
      filePath: proposal.filePath,
      beforeText: currentText,
      afterText,
    })
    return afterText
  }
}

function createUndoId(proposal: EditProposal): string {
  return `inline-edit:${proposal.filePath}:${hash(`${proposal.originalText}\u0000${proposal.proposedText}`)}`
}

function hash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16)
}
