import { describe, expect, it } from "vitest"
import { applyApprovedHunks, approveHunk, computeHash, createEditProposal } from "./EditProposal"

describe("EditProposal", () => {
  it("creates a non-mutating proposal with cryptographic hashes and applies only explicitly approved hunks", () => {
    const original = "title\nkeep\nfooter"
    const proposed = "title\nchanged\nfooter\nnew line"
    const proposal = createEditProposal("notes.txt", original, proposed)

    expect(proposal.originalText).toBe(original)
    expect(proposal.originalHash).toBe(computeHash(original))
    expect(proposal.expectedHash).toBe(computeHash(original))
    expect(proposal.proposedText).toBe(proposed)
    expect(proposal.hunks).toHaveLength(2)
    expect(applyApprovedHunks(proposal)).toBe(original)

    const approved = approveHunk(proposal, proposal.hunks[0].id)
    expect(applyApprovedHunks(approved)).toBe("title\nchanged\nfooter")
    expect(proposal.hunks[0]?.approved).toBe(false)
  })

  it("requires a real hunk identifier", () => {
    const proposal = createEditProposal("notes.txt", "a", "b")
    expect(() => approveHunk(proposal, "missing")).toThrow("Unknown edit hunk")
  })
})

