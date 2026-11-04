import { describe, expect, it, vi } from "vitest"
import { SafeUndoService } from "./SafeUndo"
import {
  InlineEditConflictError,
  InlineEditService,
  createInlineEditProposal,
  type InlineEditWorkspace,
} from "./InlineEditFlow"

function createWorkspace(initial: string): InlineEditWorkspace & { text: string; writes: string[] } {
  const workspace = {
    text: initial,
    writes: [] as string[],
    async readText() {
      return workspace.text
    },
    async writeText(_filePath: string, text: string) {
      workspace.text = text
      workspace.writes.push(text)
    },
  }
  return workspace
}

describe("InlineEditService", () => {
  it("replaces only the selected range and opens the native review boundary", async () => {
    const proposal = createInlineEditProposal({
      filePath: "notes.ts",
      documentText: "const title = 'old'\nconst count = 1\n",
      selectionStart: 14,
      selectionEnd: 19,
      replacementText: "'new'",
    })
    const open = vi.fn(async () => {})
    const service = new InlineEditService(createWorkspace(proposal.originalText), { open }, new SafeUndoService())

    await service.reviewProposal(proposal, "typescript")

    expect(proposal.proposedText).toBe("const title = 'new'\nconst count = 1\n")
    expect(proposal.hunks).toHaveLength(1)
    expect(open).toHaveBeenCalledWith(proposal, "typescript")
  })

  it("applies approved hunks and records an undo entry", async () => {
    const workspace = createWorkspace("const value = 1\n")
    const undo = new SafeUndoService()
    const proposal = createInlineEditProposal({
      filePath: "notes.ts",
      documentText: workspace.text,
      selectionStart: 14,
      selectionEnd: 15,
      replacementText: "2",
    })
    proposal.hunks[0].approved = true
    const service = new InlineEditService(workspace, { open: async () => {} }, undo)

    await expect(service.applyApprovedProposal(proposal)).resolves.toBe("const value = 2\n")
    expect(workspace.writes).toEqual(["const value = 2\n"])
    expect(undo.listPending()).toHaveLength(1)
  })

  it("refuses to apply after the document changes", async () => {
    const workspace = createWorkspace("const value = 1\n")
    const proposal = createInlineEditProposal({
      filePath: "notes.ts",
      documentText: workspace.text,
      selectionStart: 14,
      selectionEnd: 15,
      replacementText: "2",
    })
    proposal.hunks[0].approved = true
    workspace.text = "const value = 3\n"
    const service = new InlineEditService(workspace, { open: async () => {} }, new SafeUndoService())

    await expect(service.applyApprovedProposal(proposal)).rejects.toBeInstanceOf(InlineEditConflictError)
    expect(workspace.writes).toEqual([])
  })

  it("rejects an unapproved proposal", async () => {
    const proposal = createInlineEditProposal({
      filePath: "notes.ts",
      documentText: "old\n",
      selectionStart: 0,
      selectionEnd: 3,
      replacementText: "new",
    })
    const service = new InlineEditService(createWorkspace("old\n"), { open: async () => {} }, new SafeUndoService())

    await expect(service.applyApprovedProposal(proposal)).rejects.toThrow("approved change")
  })
})
