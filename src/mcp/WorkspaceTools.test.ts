import { describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { WorkspaceTools } from "./WorkspaceTools"
import { applyApprovedHunks } from "../edits/EditProposal"
import { SafeUndoService } from "../edits/SafeUndo"

describe("WorkspaceTools per-hunk review and safe undo", () => {
  it("generates hunks, applies only the approved hunk, preserves proposal, and supports safe undo", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-tools-test-"))
    try {
      const testFile = "sample.txt"
      const originalContent = "line 1\nline 2\nline 3\nline 4\nline 5\n"
      // Change line 2 to "line 2 modified" (hunk 0) and line 4 to "line 4 modified" (hunk 1)
      const proposedContent = "line 1\nline 2 modified\nline 3\nline 4 modified\nline 5\n"
      await fs.writeFile(path.join(tempDir, testFile), originalContent, "utf8")

      const undo = new SafeUndoService()
      let currentFileContent = originalContent

      const tools = new WorkspaceTools({
        workspaceRoot: tempDir,
        applyHunk: async (proposal, hunkId) => {
          const beforeText = currentFileContent
          const afterText = applyApprovedHunks(proposal.editProposal)
          currentFileContent = afterText
          await fs.writeFile(path.join(tempDir, proposal.path), afterText, "utf8")

          undo.recordAppliedEdit({
            id: `${proposal.path}:${hunkId}:${Date.now()}`,
            filePath: path.join(tempDir, proposal.path),
            beforeText,
            afterText,
          })
          return { proposalId: proposal.id, hunkId, path: proposal.path, applied: true }
        },
      })

      // 1. Propose changes
      const proposalResult = await tools.proposeChanges([
        { path: testFile, proposedText: proposedContent },
      ])
      expect(proposalResult.proposals).toHaveLength(1)
      const proposal = proposalResult.proposals[0]
      expect(proposal.hunks.length).toBeGreaterThanOrEqual(2)
      const hunk0 = proposal.hunks[0]
      const hunk1 = proposal.hunks[1]

      // 2. Approve ONLY hunk 0
      const applyResult0 = await tools.applyHunk(proposal.id, hunk0.id)
      expect(applyResult0.applied).toBe(true)
      expect(applyResult0.hunkId).toBe(hunk0.id)

      // Content on disk should have line 2 modified, but line 4 UNTOUCHED
      const onDiskAfterHunk0 = await fs.readFile(path.join(tempDir, testFile), "utf8")
      expect(onDiskAfterHunk0).toContain("line 2 modified")
      expect(onDiskAfterHunk0).not.toContain("line 4 modified")
      expect(onDiskAfterHunk0).toContain("line 4\n")

      // 3. Proposal is preserved: approve hunk 1
      const applyResult1 = await tools.applyHunk(proposal.id, hunk1.id)
      expect(applyResult1.applied).toBe(true)
      expect(applyResult1.hunkId).toBe(hunk1.id)

      // Now both hunks are applied
      const onDiskAfterHunk1 = await fs.readFile(path.join(tempDir, testFile), "utf8")
      expect(onDiskAfterHunk1).toContain("line 2 modified")
      expect(onDiskAfterHunk1).toContain("line 4 modified")

      // 4. Safe Undo: undo second edit, then first edit
      const pendingUndos = undo.listPending()
      expect(pendingUndos).toHaveLength(2)

      const undoWorkspace = {
        readText: async (fp: string) => fs.readFile(fp, "utf8"),
        writeText: async (fp: string, text: string) => {
          currentFileContent = text
          await fs.writeFile(fp, text, "utf8")
        },
      }

      // Undo hunk 1 edit
      await undo.undo(pendingUndos[1].id, undoWorkspace)
      const onDiskAfterUndo1 = await fs.readFile(path.join(tempDir, testFile), "utf8")
      expect(onDiskAfterUndo1).toContain("line 2 modified")
      expect(onDiskAfterUndo1).not.toContain("line 4 modified")

      // Undo hunk 0 edit
      await undo.undo(pendingUndos[0].id, undoWorkspace)
      const onDiskRestored = await fs.readFile(path.join(tempDir, testFile), "utf8")
      expect(onDiskRestored).toBe(originalContent)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it("invokes configured symbol provider", async () => {
    let queriedPath: string | undefined
    let queriedQuery: string | undefined
    const tools = new WorkspaceTools({
      workspaceRoot: process.cwd(),
      symbolProvider: async (p, q) => {
        queriedPath = p
        queriedQuery = q
        return { symbols: [{ name: "myFunction", kind: 12 }] }
      },
    })

    const result = await tools.getSymbols("src/test.ts", "myFunc")
    expect(queriedPath).toBe("src/test.ts")
    expect(queriedQuery).toBe("myFunc")
    expect(result).toEqual({ symbols: [{ name: "myFunction", kind: 12 }] })
  })

  it("filters files according to .gitignore", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-tools-ignore-"))
    try {
      await fs.writeFile(path.join(tempDir, ".gitignore"), "ignored.txt\nbuild/\n*.log\n", "utf8")
      await fs.writeFile(path.join(tempDir, "visible.txt"), "hello", "utf8")
      await fs.writeFile(path.join(tempDir, "ignored.txt"), "secret", "utf8")
      await fs.writeFile(path.join(tempDir, "debug.log"), "log", "utf8")
      await fs.mkdir(path.join(tempDir, "build"))
      await fs.writeFile(path.join(tempDir, "build", "output.js"), "code", "utf8")

      const tools = new WorkspaceTools({ workspaceRoot: tempDir })
      const list = await tools.listWorkspace()
      const paths = list.files.map((f) => f.path)

      expect(paths).toContain("visible.txt")
      expect(paths).not.toContain("ignored.txt")
      expect(paths).not.toContain("debug.log")
      expect(paths).not.toContain("build/output.js")
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it("verifies original file hash and rejects stale proposals when file changed before applying hunk", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-tools-stale-"))
    try {
      const testFile = "stale-test.txt"
      const originalContent = "original content\nsecond line\n"
      await fs.writeFile(path.join(tempDir, testFile), originalContent, "utf8")

      const tools = new WorkspaceTools({
        workspaceRoot: tempDir,
        applyHunk: async () => ({ applied: true }),
      })

      const proposalResult = await tools.proposeChanges([
        { path: testFile, proposedText: "modified content\nsecond line\n" },
      ])
      const proposal = proposalResult.proposals[0]

      // Simulate external user edit before hunk application
      await fs.writeFile(path.join(tempDir, testFile), "newer user edit\nsecond line\n", "utf8")

      // Attempt to apply hunk must be rejected because file hash changed
      await expect(tools.applyHunk(proposal.id, proposal.hunks[0].id)).rejects.toThrow(
        /file content has changed since the proposal was created.*Stale proposal rejected/,
      )

      // Verify file content was NOT overwritten
      const diskContent = await fs.readFile(path.join(tempDir, testFile), "utf8")
      expect(diskContent).toBe("newer user edit\nsecond line\n")
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it("rejects when external modification occurs between hunk approvals and preserves user edits", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-tools-inter-hunk-"))
    try {
      const testFile = "sample.txt"
      const originalContent = "line 1\nline 2\nline 3\nline 4\nline 5\n"
      const proposedContent = "line 1\nline 2 modified\nline 3\nline 4 modified\nline 5\n"
      await fs.writeFile(path.join(tempDir, testFile), originalContent, "utf8")

      let currentFileContent = originalContent
      const tools = new WorkspaceTools({
        workspaceRoot: tempDir,
        applyHunk: async (proposal) => {
          const afterText = applyApprovedHunks(proposal.editProposal)
          currentFileContent = afterText
          await fs.writeFile(path.join(tempDir, proposal.path), afterText, "utf8")
          return { applied: true }
        },
      })

      const proposalResult = await tools.proposeChanges([{ path: testFile, proposedText: proposedContent }])
      const proposal = proposalResult.proposals[0]
      expect(proposal.hunks.length).toBeGreaterThanOrEqual(2)

      // Apply first hunk
      const result0 = await tools.applyHunk(proposal.id, proposal.hunks[0].id)
      expect(result0.applied).toBe(true)

      // External user edit occurs between hunk 0 and hunk 1
      const externalEdit = "line 1\nline 2 modified\nuser inserted line\nline 4\nline 5\n"
      await fs.writeFile(path.join(tempDir, testFile), externalEdit, "utf8")

      // Attempt to apply hunk 1 must be rejected
      await expect(tools.applyHunk(proposal.id, proposal.hunks[1].id)).rejects.toThrow(
        /file content has changed since the proposal was created.*Stale proposal rejected/,
      )

      // Disk content must remain the external edit (user changes preserved)
      const diskContent = await fs.readFile(path.join(tempDir, testFile), "utf8")
      expect(diskContent).toBe(externalEdit)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it("leaves expectedHash unchanged and does not mark hunk applied when write fails", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-tools-fail-write-"))
    try {
      const testFile = "fail-write.txt"
      const originalContent = "original text\n"
      await fs.writeFile(path.join(tempDir, testFile), originalContent, "utf8")

      let shouldFail = true
      const tools = new WorkspaceTools({
        workspaceRoot: tempDir,
        applyHunk: async (proposal) => {
          if (shouldFail) {
            throw new Error("Disk write simulated failure")
          }
          const afterText = applyApprovedHunks(proposal.editProposal)
          await fs.writeFile(path.join(tempDir, proposal.path), afterText, "utf8")
          return { applied: true }
        },
      })

      const proposalResult = await tools.proposeChanges([
        { path: testFile, proposedText: "modified text\n" },
      ])
      const proposal = proposalResult.proposals[0]
      const originalHash = proposal.originalHash

      // Attempt apply when write fails
      await expect(tools.applyHunk(proposal.id, proposal.hunks[0].id)).rejects.toThrow(
        "Disk write simulated failure",
      )

      // Stored proposal state must have expectedHash untouched and hunk not marked applied
      const stored = tools.getProposal(proposal.id)!
      expect(stored.expectedHash).toBe(originalHash)
      expect(stored.appliedHunkIds.has(proposal.hunks[0].id)).toBe(false)
      expect(stored.editProposal.hunks[0].approved).toBe(false)

      // File on disk remains unchanged
      expect(await fs.readFile(path.join(tempDir, testFile), "utf8")).toBe(originalContent)

      // Subsequent retry with working write succeeds
      shouldFail = false
      const retryResult = await tools.applyHunk(proposal.id, proposal.hunks[0].id)
      expect(retryResult.applied).toBe(true)
      expect(await fs.readFile(path.join(tempDir, testFile), "utf8")).toBe("modified text\n")
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})

