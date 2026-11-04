import { describe, expect, it } from "vitest"
import { ContextService } from "./ContextService"
import { ContextDatabase } from "./db/Database"

async function setup(): Promise<{ database: ContextDatabase; service: ContextService }> {
  const database = await ContextDatabase.open()
  database.run(
    "INSERT INTO app_sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ["session-a", "A", "now", "now"],
  )
  database.run(
    "INSERT INTO app_sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ["session-b", "B", "now", "now"],
  )
  return { database, service: new ContextService(database) }
}

describe("ContextService", () => {
  it("creates inbox blocks and preserves independent membership fields", async () => {
    const { database, service } = await setup()
    try {
      const block = await service.create({
        sessionId: "session-a",
        title: "Instruction",
        content: "Keep API stable.",
        sourceType: "user",
        provenance: "test",
      })
      expect(service.getMembership("session-a", block.id)).toMatchObject({
        status: "inbox",
        priority: null,
        scope: "task",
      })
    } finally {
      database.close()
    }
  })

  it("captures observations in Inbox without changing their source or injecting them", async () => {
    const { database, service } = await setup()
    try {
      const observation = await service.captureObservation({
        sessionId: "session-a",
        content: "The parser rejects empty input.",
        provenance: "turn:turn-7",
        originalRef: "file:src/parser.ts:42",
      })
      expect(observation.sourceType).toBe("observation")
      expect(observation.provenance).toBe("turn:turn-7")
      expect(observation.originalRef).toBe("file:src/parser.ts:42")
      expect(service.getMembership("session-a", observation.id)).toMatchObject({
        status: "inbox",
        scope: "task",
        priority: null,
        pinned: false,
      })
      expect(service.listSessionContext("session-a")).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it("moves, stores, attaches and copies with the required identity semantics", async () => {
    const { database, service } = await setup()
    try {
      const block = await service.create({
        sessionId: "session-a",
        title: "Transfer",
        content: "Content",
        sourceType: "user",
        provenance: "test",
      })
      await service.move("session-a", "session-b", block.id)
      expect(() => service.getMembership("session-a", block.id)).toThrow()
      expect(service.getMembership("session-b", block.id).blockId).toBe(block.id)

      const copiedId = await service.copy("session-b", "session-a", block.id)
      expect(copiedId).not.toBe(block.id)
      expect(database.all("SELECT parent_block_id FROM context_blocks WHERE id = ?", [copiedId])).toEqual([
        { parent_block_id: block.id },
      ])

      await service.store("session-b", block.id, "global")
      expect(database.all("SELECT block_id FROM library_entries")).toEqual([{ block_id: block.id }])
      await service.attach("session-a", block.id, "project")
      expect(database.all("SELECT block_id FROM session_memberships WHERE session_id = ?", ["session-a"])).toHaveLength(2)
    } finally {
      database.close()
    }
  })

  it("enforces locks and pinned demotion rules", async () => {
    const { database, service } = await setup()
    try {
      const block = await service.create({
        sessionId: "session-a",
        title: "Protected",
        content: "Content",
        sourceType: "user",
        provenance: "test",
      })
      await service.setPriority("session-a", block.id, "P0")
      await service.pin("session-a", block.id)
      await expect(service.setPriority("session-a", block.id, "P2")).rejects.toThrow("Pinned")
      await service.lock("session-a", block.id)
      await expect(service.edit("session-a", block.id, "New", "New")).rejects.toThrow("Locked")
      await expect(service.delete("session-a", block.id)).rejects.toThrow("Locked")
      await expect(service.move("session-a", "session-b", block.id)).rejects.toThrow("Locked")
    } finally {
      database.close()
    }
  })
})
