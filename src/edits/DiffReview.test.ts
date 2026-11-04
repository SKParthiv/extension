import { describe, expect, it, vi } from "vitest"
import { createEditProposal } from "./EditProposal"
import { DiffReviewService } from "./DiffReview"

describe("DiffReviewService", () => {
  it("opens original and proposed content in the native vscode.diff command", async () => {
    const originalUri = { scheme: "untitled", path: "original" }
    const proposedUri = { scheme: "untitled", path: "proposed" }
    const openTextDocument = vi
      .fn()
      .mockResolvedValueOnce({ uri: originalUri })
      .mockResolvedValueOnce({ uri: proposedUri })
    const executeCommand = vi.fn().mockResolvedValue(undefined)
    const service = new DiffReviewService({ openTextDocument, executeCommand })
    const proposal = createEditProposal("notes.ts", "const value = 1", "const value = 2")

    await service.open(proposal, "typescript")

    expect(openTextDocument).toHaveBeenNthCalledWith(1, {
      content: "const value = 1",
      language: "typescript",
    })
    expect(openTextDocument).toHaveBeenNthCalledWith(2, {
      content: "const value = 2",
      language: "typescript",
    })
    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.diff",
      originalUri,
      proposedUri,
      "TrueForge review: notes.ts",
    )
  })

  it("rejects empty proposals", async () => {
    const service = new DiffReviewService({
      openTextDocument: vi.fn(),
      executeCommand: vi.fn(),
    })
    await expect(
      service.open({ filePath: "empty.ts", originalText: "same", proposedText: "same", hunks: [] }),
    ).rejects.toThrow("empty")
  })
})
