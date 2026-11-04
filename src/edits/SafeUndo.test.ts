import { describe, expect, it } from "vitest"
import { SafeUndoService, UndoConflictError, type UndoWorkspace } from "./SafeUndo"

function createWorkspace(initial: Record<string, string>): UndoWorkspace & { writes: string[] } {
  const files = new Map(Object.entries(initial))
  const writes: string[] = []
  return {
    writes,
    async readText(filePath) {
      const value = files.get(filePath)
      if (value === undefined) {
        throw new Error(`Missing test file: ${filePath}`)
      }
      return value
    },
    async writeText(filePath, text) {
      files.set(filePath, text)
      writes.push(`${filePath}:${text}`)
    },
  }
}

describe("SafeUndoService", () => {
  it("restores the exact approved-before text and consumes the record", async () => {
    const service = new SafeUndoService()
    const workspace = createWorkspace({ "notes.ts": "after" })
    service.recordAppliedEdit({
      id: "edit-1",
      filePath: "notes.ts",
      beforeText: "before",
      afterText: "after",
    })

    await expect(service.undo("edit-1", workspace)).resolves.toEqual({
      recordId: "edit-1",
      filePath: "notes.ts",
      restoredText: "before",
    })
    expect(workspace.writes).toEqual(["notes.ts:before"])
    expect(service.listPending()).toEqual([])
    await expect(service.undo("edit-1", workspace)).rejects.toThrow("Unknown or already consumed")
  })

  it("refuses to overwrite a file changed after the approved edit", async () => {
    const service = new SafeUndoService()
    const workspace = createWorkspace({ "notes.ts": "someone else's change" })
    const record = {
      id: "edit-2",
      filePath: "notes.ts",
      beforeText: "before",
      afterText: "after",
    }
    service.recordAppliedEdit(record)

    await expect(service.undo(record.id, workspace)).rejects.toBeInstanceOf(UndoConflictError)
    expect(workspace.writes).toEqual([])
    expect(service.listPending()).toEqual([record])
  })

  it("rejects duplicate and no-op records", () => {
    const service = new SafeUndoService()
    const record = {
      id: "edit-3",
      filePath: "notes.ts",
      beforeText: "same",
      afterText: "same",
    }

    expect(() => service.recordAppliedEdit(record)).toThrow("must change")
    service.recordAppliedEdit({ ...record, afterText: "changed" })
    expect(() => service.recordAppliedEdit({ ...record, afterText: "changed again" })).toThrow("already exists")
  })
})
