import { randomUUID } from "node:crypto"
import type { ContextDatabase, QueryRow } from "./db/Database"
import type { ContextCandidate } from "./ContextSelector"

export type ContextScope = "task" | "project" | "global"
export type ContextPriority = "P0" | "P1" | "P2" | "P3"
export type ContextStatus = "inbox" | "active" | "deferred" | "archived" | "excluded" | "resolved"
export type LibraryVisibility = "global" | "project"

export interface CreateBlockInput {
  sessionId: string
  title: string
  content: string
  sourceType: string
  provenance: string
  tokenEstimate?: number
  originalRef?: string
  scope?: ContextScope
}

export interface CaptureObservationInput {
  sessionId: string
  content: string
  provenance: string
  title?: string
  originalRef?: string
  tokenEstimate?: number
}

export interface ContextBlock {
  id: string
  title: string
  content: string
  sourceType: string
  provenance: string
  parentBlockId: string | null
  tokenEstimate: number
  originalRef: string | null
  createdAt: string
  updatedAt: string
}

export interface SessionMembership {
  sessionId: string
  blockId: string
  scope: ContextScope
  priority: ContextPriority | null
  status: ContextStatus
  position: number
  pinned: boolean
  locked: boolean
}

export interface AppSession {
  id: string
  title: string
  trueforgeSessionId: string | null
  createdAt: string
  updatedAt: string
}

export class ContextService {
  public constructor(private readonly database: ContextDatabase) {}

  public async create(input: CreateBlockInput): Promise<ContextBlock> {
    const now = new Date().toISOString()
    const id = randomUUID()
    await this.database.transaction(() => {
      this.requireSession(input.sessionId)
      const position = this.nextPosition(input.sessionId)
      this.database.run(
        `INSERT INTO context_blocks
          (id, title, content, source_type, provenance, token_estimate, original_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.title,
          input.content,
          input.sourceType,
          input.provenance,
          input.tokenEstimate ?? 0,
          input.originalRef ?? null,
          now,
          now,
        ],
      )
      this.database.run(
        `INSERT INTO session_memberships(session_id, block_id, scope, priority, status, position)
         VALUES (?, ?, ?, NULL, 'inbox', ?)`,
        [input.sessionId, id, input.scope ?? "task", position],
      )
    })
    return this.requireBlock(id)
  }

  public async captureObservation(input: CaptureObservationInput): Promise<ContextBlock> {
    const title = input.title?.trim() || "Observation"
    const block = await this.create({
      sessionId: input.sessionId,
      title,
      content: input.content,
      sourceType: "observation",
      provenance: input.provenance,
      originalRef: input.originalRef,
      tokenEstimate: input.tokenEstimate,
      scope: "task",
    })
    return block
  }

  public async edit(sessionId: string, blockId: string, title: string, content: string): Promise<void> {
    const membership = this.requireMembership(sessionId, blockId)
    this.assertUnlocked(membership)
    this.database.run(
      "UPDATE context_blocks SET title = ?, content = ?, updated_at = ? WHERE id = ?",
      [title, content, new Date().toISOString(), blockId],
    )
    await this.database.save()
  }

  public async delete(sessionId: string, blockId: string): Promise<void> {
    const membership = this.requireMembership(sessionId, blockId)
    this.assertUnlocked(membership)
    this.database.run("DELETE FROM context_blocks WHERE id = ?", [blockId])
    await this.database.save()
  }

  public async reorder(sessionId: string, blockId: string, position: number): Promise<void> {
    this.requireMembership(sessionId, blockId)
    if (!Number.isInteger(position) || position < 0) {
      throw new Error("Position must be a non-negative integer.")
    }
    this.database.run(
      "UPDATE session_memberships SET position = ? WHERE session_id = ? AND block_id = ?",
      [position, sessionId, blockId],
    )
    await this.database.save()
  }

  public async setPriority(
    sessionId: string,
    blockId: string,
    priority: ContextPriority | null,
    overridePinned = false,
  ): Promise<void> {
    const membership = this.requireMembership(sessionId, blockId)
    if (membership.pinned && isDemotion(membership.priority, priority) && !overridePinned) {
      throw new Error("Pinned blocks require an explicit override before demotion.")
    }
    this.database.run(
      "UPDATE session_memberships SET priority = ? WHERE session_id = ? AND block_id = ?",
      [priority, sessionId, blockId],
    )
    await this.database.save()
  }

  public async setScope(sessionId: string, blockId: string, scope: ContextScope): Promise<void> {
    this.requireMembership(sessionId, blockId)
    this.database.run(
      "UPDATE session_memberships SET scope = ? WHERE session_id = ? AND block_id = ?",
      [scope, sessionId, blockId],
    )
    await this.database.save()
  }

  public async setStatus(sessionId: string, blockId: string, status: ContextStatus): Promise<void> {
    this.requireMembership(sessionId, blockId)
    this.database.run(
      "UPDATE session_memberships SET status = ? WHERE session_id = ? AND block_id = ?",
      [status, sessionId, blockId],
    )
    await this.database.save()
  }

  public async pin(sessionId: string, blockId: string): Promise<void> {
    this.requireMembership(sessionId, blockId)
    this.database.run(
      "UPDATE session_memberships SET pinned = 1 WHERE session_id = ? AND block_id = ?",
      [sessionId, blockId],
    )
    await this.database.save()
  }

  public async unpin(sessionId: string, blockId: string): Promise<void> {
    this.requireMembership(sessionId, blockId)
    this.database.run(
      "UPDATE session_memberships SET pinned = 0 WHERE session_id = ? AND block_id = ?",
      [sessionId, blockId],
    )
    await this.database.save()
  }

  public async lock(sessionId: string, blockId: string): Promise<void> {
    this.requireMembership(sessionId, blockId)
    this.database.run(
      "UPDATE session_memberships SET locked = 1 WHERE session_id = ? AND block_id = ?",
      [sessionId, blockId],
    )
    await this.database.save()
  }

  public async unlock(sessionId: string, blockId: string): Promise<void> {
    this.requireMembership(sessionId, blockId)
    this.database.run(
      "UPDATE session_memberships SET locked = 0 WHERE session_id = ? AND block_id = ?",
      [sessionId, blockId],
    )
    await this.database.save()
  }

  public async move(sourceSessionId: string, destinationSessionId: string, blockId: string): Promise<void> {
    await this.database.transaction(() => {
      const membership = this.requireMembership(sourceSessionId, blockId)
      this.assertUnlocked(membership)
      this.requireSession(destinationSessionId)
      this.database.run(
        "DELETE FROM session_memberships WHERE session_id = ? AND block_id = ?",
        [sourceSessionId, blockId],
      )
      this.database.run(
        `INSERT INTO session_memberships(session_id, block_id, scope, priority, status, position, pinned, locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          destinationSessionId,
          blockId,
          membership.scope,
          membership.priority,
          membership.status,
          this.nextPosition(destinationSessionId),
          membership.pinned ? 1 : 0,
          membership.locked ? 1 : 0,
        ],
      )
    })
  }

  public async copy(sourceSessionId: string, destinationSessionId: string, blockId: string): Promise<string> {
    const copiedBlockId = randomUUID()
    await this.database.transaction(() => {
      const membership = this.requireMembership(sourceSessionId, blockId)
      this.requireSession(destinationSessionId)
      const block = this.requireBlock(blockId)
      const now = new Date().toISOString()
      this.database.run(
        `INSERT INTO context_blocks
          (id, title, content, source_type, provenance, parent_block_id, token_estimate, original_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          copiedBlockId,
          block.title,
          block.content,
          block.sourceType,
          block.provenance,
          block.id,
          block.tokenEstimate,
          block.originalRef,
          now,
          now,
        ],
      )
      this.database.run(
        `INSERT INTO session_memberships(session_id, block_id, scope, priority, status, position)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          destinationSessionId,
          copiedBlockId,
          membership.scope,
          membership.priority,
          membership.status,
          this.nextPosition(destinationSessionId),
        ],
      )
    })
    return copiedBlockId
  }

  public async store(sessionId: string, blockId: string, visibility: LibraryVisibility): Promise<void> {
    await this.database.transaction(() => {
      const membership = this.requireMembership(sessionId, blockId)
      this.assertUnlocked(membership)
      this.database.run(
        "DELETE FROM session_memberships WHERE session_id = ? AND block_id = ?",
        [sessionId, blockId],
      )
      this.database.run(
        "INSERT INTO library_entries(block_id, visibility) VALUES (?, ?) ON CONFLICT(block_id) DO UPDATE SET visibility = excluded.visibility",
        [blockId, visibility],
      )
    })
  }

  public async attach(sessionId: string, blockId: string, scope: ContextScope): Promise<void> {
    await this.database.transaction(() => {
      this.requireSession(sessionId)
      this.requireBlock(blockId)
      this.database.run(
        `INSERT INTO session_memberships(session_id, block_id, scope, status, position)
         VALUES (?, ?, ?, 'inbox', ?)`,
        [sessionId, blockId, scope, this.nextPosition(sessionId)],
      )
    })
  }

  public async restore(sessionId: string, blockId: string): Promise<void> {
    this.requireMembership(sessionId, blockId)
    this.database.run(
      "UPDATE session_memberships SET status = 'inbox' WHERE session_id = ? AND block_id = ?",
      [sessionId, blockId],
    )
    await this.database.save()
  }

  public getMembership(sessionId: string, blockId: string): SessionMembership {
    return this.requireMembership(sessionId, blockId)
  }

  public listSessionContext(sessionId: string): ContextCandidate[] {
    this.requireSession(sessionId)
    return this.database
      .all(
        `SELECT b.*, m.session_id, m.block_id, m.scope, m.priority, m.status, m.position, m.pinned, m.locked
         FROM context_blocks b
         JOIN session_memberships m ON m.block_id = b.id
         WHERE m.session_id = ?
         ORDER BY m.position, b.id`,
        [sessionId],
      )
      .map((row) => ({ block: toBlock(row), membership: toMembership(row) }))
  }

  public listLibrary(): Array<{ block: ContextBlock; visibility: LibraryVisibility }> {
    return this.database
      .all(
        `SELECT b.*, l.visibility
         FROM context_blocks b
         JOIN library_entries l ON l.block_id = b.id
         ORDER BY b.updated_at DESC, b.id`,
      )
      .map((row) => ({
        block: toBlock(row),
        visibility: row.visibility as LibraryVisibility,
      }))
  }

  public listSessions(): AppSession[] {
    return this.database
      .all("SELECT * FROM app_sessions ORDER BY updated_at DESC, id")
      .map((row) => ({
        id: String(row.id),
        title: String(row.title),
        trueforgeSessionId: row.trueforge_session_id == null ? null : String(row.trueforge_session_id),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }))
  }

  public async setTrueForgeSessionId(sessionId: string, trueforgeSessionId: string): Promise<void> {
    this.requireSession(sessionId)
    this.database.run(
      "UPDATE app_sessions SET trueforge_session_id = ?, updated_at = ? WHERE id = ?",
      [trueforgeSessionId, new Date().toISOString(), sessionId],
    )
    await this.database.save()
  }

  private requireSession(sessionId: string): void {
    if (this.database.all("SELECT id FROM app_sessions WHERE id = ?", [sessionId]).length === 0) {
      throw new Error(`Unknown session: ${sessionId}`)
    }
  }

  private requireBlock(blockId: string): ContextBlock {
    const rows = this.database.all("SELECT * FROM context_blocks WHERE id = ?", [blockId])
    const row = rows[0]
    if (!row) {
      throw new Error(`Unknown context block: ${blockId}`)
    }
    return toBlock(row)
  }

  private requireMembership(sessionId: string, blockId: string): SessionMembership {
    const rows = this.database.all(
      "SELECT * FROM session_memberships WHERE session_id = ? AND block_id = ?",
      [sessionId, blockId],
    )
    const row = rows[0]
    if (!row) {
      throw new Error(`Block ${blockId} is not attached to session ${sessionId}`)
    }
    return toMembership(row)
  }

  private nextPosition(sessionId: string): number {
    const rows = this.database.all(
      "SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM session_memberships WHERE session_id = ?",
      [sessionId],
    )
    return Number(rows[0]?.next_position ?? 0)
  }

  private assertUnlocked(membership: SessionMembership): void {
    if (membership.locked) {
      throw new Error("Locked blocks cannot be edited, deleted or moved.")
    }
  }
}

function isDemotion(current: ContextPriority | null, next: ContextPriority | null): boolean {
  const rank = (priority: ContextPriority | null) => (priority ? Number(priority.slice(1)) : 4)
  return rank(next) > rank(current)
}

function toBlock(row: QueryRow): ContextBlock {
  return {
    id: String(row.id),
    title: String(row.title),
    content: String(row.content),
    sourceType: String(row.source_type),
    provenance: String(row.provenance),
    parentBlockId: row.parent_block_id == null ? null : String(row.parent_block_id),
    tokenEstimate: Number(row.token_estimate),
    originalRef: row.original_ref == null ? null : String(row.original_ref),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function toMembership(row: QueryRow): SessionMembership {
  return {
    sessionId: String(row.session_id),
    blockId: String(row.block_id),
    scope: row.scope as ContextScope,
    priority: row.priority == null ? null : (row.priority as ContextPriority),
    status: row.status as ContextStatus,
    position: Number(row.position),
    pinned: Number(row.pinned) === 1,
    locked: Number(row.locked) === 1,
  }
}
