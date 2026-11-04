import { describe, expect, it } from "vitest"
import { ContextDatabase } from "./Database"

describe("ContextDatabase", () => {
  it("applies migrations and enables foreign keys", async () => {
    const database = await ContextDatabase.open()
    try {
      expect(database.all("SELECT version FROM schema_migrations")).toEqual([{ version: 1 }])
      expect(database.all("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }])
      database.run(
        "INSERT INTO app_sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ["session-1", "Test", "now", "now"],
      )
      database.run(
        "INSERT INTO context_blocks(id, title, content, source_type, provenance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["block-1", "Block", "Content", "user", "test", "now", "now"],
      )
      database.run(
        "INSERT INTO session_memberships(session_id, block_id, scope, status) VALUES (?, ?, ?, ?)",
        ["session-1", "block-1", "task", "inbox"],
      )
      expect(database.all("SELECT block_id FROM session_memberships")).toEqual([{ block_id: "block-1" }])
    } finally {
      database.close()
    }
  })

  it("enforces independent scope, priority, status and foreign-key constraints", async () => {
    const database = await ContextDatabase.open()
    try {
      expect(() =>
        database.run(
          "INSERT INTO session_memberships(session_id, block_id, scope, priority, status) VALUES (?, ?, ?, ?, ?)",
          ["missing", "missing", "task", "P9", "active"],
        ),
      ).toThrow()
    } finally {
      database.close()
    }
  })
})

