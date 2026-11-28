import { describe, expect, it, vi } from "vitest"
import { ContextDatabase } from "./db/Database"
import { ContextService } from "./ContextService"
import { NotTheLeastController } from "../runtime/NotTheLeastController"
import { assembleContext } from "./ContextAssembler"
import { formatPromptWithContext } from "./PromptContext"

vi.mock("vscode", () => {
  return {
    Disposable: class {
      constructor(readonly dispose: () => void) {}
    },
    workspace: {
      getConfiguration() {
        return { get: vi.fn(() => "") }
      },
    },
    window: {
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      createOutputChannel: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    },
    env: { clipboard: { writeText: vi.fn() } },
    Uri: {
      joinPath: vi.fn((base: any, ...segments: string[]) => ({ fsPath: `${base?.fsPath ?? ""}/${segments.join("/")}` })),
    },
  }
})

describe("Context Manager UI & Controller operations", () => {
  async function setup() {
    const database = await ContextDatabase.open()
    const service = new ContextService(database)
    const session1 = await service.createSession("Session 1", "s-1")
    const session2 = await service.createSession("Session 2", "s-2")

    const block = await service.create({
      sessionId: session1.id,
      title: "Initial Block",
      content: "Initial Content",
      sourceType: "user",
      provenance: "manual",
      tokenEstimate: 10,
    })

    const ctrl = new NotTheLeastController()
    ;(ctrl as any).service = service
    ;(ctrl as any).database = database
    ;(ctrl as any).activeSessionId = session1.id

    const broadcastMessages: any[] = []
    ctrl.registerView("context", (msg) => broadcastMessages.push(msg))

    return { database, service, session1, session2, block, ctrl, broadcastMessages }
  }

  it("persists property editing and keeps priority, scope, and status independent", async () => {
    const { database, ctrl, block } = await setup()
    try {
      // 1. Edit priority
      await ctrl.handleContextAction({ action: "setPriority", blockId: block.id, priority: "P0" })
      let snap = ctrl.getContextSnapshotSync()!
      let b = snap.blocks.find((x) => x.id === block.id)!
      expect(b.priority).toBe("P0")
      expect(b.scope).toBe("task") // unchanged
      expect(b.status).toBe("inbox") // unchanged

      // 2. Edit scope
      await ctrl.handleContextAction({ action: "setScope", blockId: block.id, scope: "project" })
      snap = ctrl.getContextSnapshotSync()!
      b = snap.blocks.find((x) => x.id === block.id)!
      expect(b.priority).toBe("P0") // unchanged
      expect(b.scope).toBe("project")
      expect(b.status).toBe("inbox") // unchanged

      // 3. Edit status
      await ctrl.handleContextAction({ action: "setStatus", blockId: block.id, status: "deferred" })
      snap = ctrl.getContextSnapshotSync()!
      b = snap.blocks.find((x) => x.id === block.id)!
      expect(b.priority).toBe("P0") // unchanged
      expect(b.scope).toBe("project") // unchanged
      expect(b.status).toBe("deferred")
    } finally {
      database.close()
    }
  })

  it("handles pin/unpin and lock/unlock independently", async () => {
    const { database, ctrl, block } = await setup()
    try {
      // Pin
      await ctrl.handleContextAction({ action: "pin", blockId: block.id })
      let snap = ctrl.getContextSnapshotSync()!
      let b = snap.blocks.find((x) => x.id === block.id)!
      expect(b.pinned).toBe(true)

      // Unpin
      await ctrl.handleContextAction({ action: "unpin", blockId: block.id })
      snap = ctrl.getContextSnapshotSync()!
      b = snap.blocks.find((x) => x.id === block.id)!
      expect(b.pinned).toBe(false)

      // Lock
      await ctrl.handleContextAction({ action: "lock", blockId: block.id })
      snap = ctrl.getContextSnapshotSync()!
      b = snap.blocks.find((x) => x.id === block.id)!
      expect(b.locked).toBe(true)

      // Attempting to move or store a locked block must fail and broadcast error
      await ctrl.handleContextAction({ action: "store", blockId: block.id })
      expect(ctrl.getContextSnapshotSync()!.library).toHaveLength(0) // not stored

      // Unlock
      await ctrl.handleContextAction({ action: "unlock", blockId: block.id })
      snap = ctrl.getContextSnapshotSync()!
      b = snap.blocks.find((x) => x.id === block.id)!
      expect(b.locked).toBe(false)
    } finally {
      database.close()
    }
  })

  it("explicitly promotes Inbox block to Active and keeps inactive blocks out of prompt", async () => {
    const { database, ctrl, service, session1 } = await setup()
    try {
      // Observation captured into inbox
      const obs = await service.captureObservation({
        sessionId: session1.id,
        content: "Important discovery",
        provenance: "test-tool",
        title: "Test Observation",
        tokenEstimate: 5,
      })

      let snap = ctrl.getContextSnapshotSync()!
      let obsBlock = snap.blocks.find((x) => x.id === obs.id)!
      expect(obsBlock.status).toBe("inbox")
      expect(obsBlock.provenance).toBe("test-tool")

      // Verify that while in inbox, it cannot enter prompt assembly
      let candidates = service.listSessionContext(session1.id)
      let assembly = assembleContext({ candidates, budget: 100 })
      let prompt = formatPromptWithContext("test", assembly)
      expect(prompt).not.toContain("Important discovery")

      // Promote to active
      await ctrl.handleContextAction({ action: "promote", blockId: obs.id })
      snap = ctrl.getContextSnapshotSync()!
      obsBlock = snap.blocks.find((x) => x.id === obs.id)!
      expect(obsBlock.status).toBe("active")

      // Now it enters prompt assembly
      candidates = service.listSessionContext(session1.id)
      assembly = assembleContext({ candidates, budget: 100 })
      prompt = formatPromptWithContext("test", assembly)
      expect(prompt).toContain("Important discovery")
    } finally {
      database.close()
    }
  })

  it("preserves Store, Move, Copy, Attach and Restore semantics", async () => {
    const { database, ctrl, session1, session2, block } = await setup()
    try {
      // 1. Copy block to session 2
      await ctrl.handleContextAction({
        action: "copy",
        blockId: block.id,
        destinationSessionId: session2.id,
      })
      await ctrl.handleSelectSession(session2.id)
      let snap = ctrl.getContextSnapshotSync()!
      expect(snap.activeSessionId).toBe(session2.id)
      expect(snap.blocks).toHaveLength(1)
      const copiedBlockId = snap.blocks[0].id
      expect(copiedBlockId).not.toBe(block.id)

      // 2. Move copied block back to session 1
      await ctrl.handleContextAction({
        action: "move",
        blockId: copiedBlockId,
        destinationSessionId: session1.id,
      })
      snap = ctrl.getContextSnapshotSync()!
      expect(snap.blocks).toHaveLength(0) // moved out of session 2

      await ctrl.handleSelectSession(session1.id)
      snap = ctrl.getContextSnapshotSync()!
      expect(snap.blocks).toHaveLength(2) // original + moved

      // 3. Store block in Library
      await ctrl.handleContextAction({ action: "store", blockId: block.id, visibility: "project" })
      snap = ctrl.getContextSnapshotSync()!
      expect(snap.blocks.find((x) => x.id === block.id)).toBeUndefined() // removed from session
      expect(snap.library.find((x) => x.id === block.id)).toBeDefined() // present in library

      // 4. Attach library block back to session 1
      await ctrl.handleContextAction({ action: "attach", blockId: block.id, scope: "task" })
      snap = ctrl.getContextSnapshotSync()!
      const attached = snap.blocks.find((x) => x.id === block.id)!
      expect(attached).toBeDefined()
      expect(attached.status).toBe("inbox") // attached as inbox

      // 5. Restore archived block to inbox
      await ctrl.handleContextAction({ action: "setStatus", blockId: block.id, status: "archived" })
      expect(ctrl.getContextSnapshotSync()!.blocks.find((x) => x.id === block.id)!.status).toBe("archived")
      await ctrl.handleContextAction({ action: "restore", blockId: block.id })
      expect(ctrl.getContextSnapshotSync()!.blocks.find((x) => x.id === block.id)!.status).toBe("inbox")
    } finally {
      database.close()
    }
  })

  it("fails safely on invalid destinations and broadcast error without corrupting state", async () => {
    const { database, ctrl, block, broadcastMessages } = await setup()
    try {
      // Move with missing destinationSessionId
      await ctrl.handleContextAction({ action: "move", blockId: block.id })
      const errorMsg = broadcastMessages.find((m) => m.type === "error")
      expect(errorMsg).toBeDefined()
      expect(errorMsg.message).toContain("Destination session is required")

      // Verify block is untouched in session 1
      const snap = ctrl.getContextSnapshotSync()!
      expect(snap.blocks.find((x) => x.id === block.id)).toBeDefined()
    } finally {
      database.close()
    }
  })
})
