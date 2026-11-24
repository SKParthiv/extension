import { describe, expect, it } from "vitest"
import { isEligibleContext, selectContext, type ContextCandidate } from "./ContextSelector"
import type { ContextStatus } from "./ContextService"

function candidate(
  id: string,
  tokenEstimate: number,
  options: Partial<ContextCandidate["membership"]> = {},
): ContextCandidate {
  return {
    block: {
      id,
      title: id,
      content: id,
      sourceType: "user",
      provenance: "test",
      parentBlockId: null,
      tokenEstimate,
      originalRef: null,
      createdAt: "now",
      updatedAt: "now",
    },
    membership: {
      sessionId: "session",
      blockId: id,
      scope: "task",
      priority: null,
      status: "active",
      position: 0,
      pinned: false,
      locked: false,
      ...options,
    },
  }
}

describe("selectContext", () => {
  it("uses pinned, priority and position as deterministic ordering signals", () => {
    const result = selectContext(
      [
        candidate("later", 2, { position: 2 }),
        candidate("p1", 2, { priority: "P1", position: 4 }),
        candidate("pinned", 2, { pinned: true, position: 9 }),
      ],
      4,
    )
    expect(result.selected.map(({ candidate: item }) => item.block.id)).toEqual(["pinned", "p1"])
    expect(result.usedTokens).toBe(4)
    expect(result.omitted.map(({ candidate: item }) => item.block.id)).toEqual(["later"])
  })

  it("includes pinned context explicitly even when it exceeds the budget", () => {
    const result = selectContext([candidate("pinned", 100, { pinned: true })], 10)
    expect(result.selected[0]?.reason).toBe("pinned")
    expect(result.usedTokens).toBe(100)
  })

  it("identifies only active blocks as eligible", () => {
    const statuses: ContextStatus[] = ["inbox", "active", "deferred", "archived", "excluded", "resolved"]
    for (const status of statuses) {
      const c = candidate(`test-${status}`, 1, { status })
      expect(isEligibleContext(c)).toBe(status === "active")
    }
  })

  it("filters inactive context before prompt selection", () => {
    const inactiveStatuses: ContextStatus[] = ["inbox", "deferred", "archived", "excluded", "resolved"]
    const candidates = [
      candidate("active-block", 2, { status: "active", priority: "P1" }),
      ...inactiveStatuses.map((status) => candidate(`inactive-${status}`, 2, { status, priority: "P0" })),
    ]

    const result = selectContext(candidates, 10)
    expect(result.selected.map(({ candidate: c }) => c.block.id)).toEqual(["active-block"])
    expect(result.omitted).toEqual([])
    expect(result.usedTokens).toBe(2)
  })

  it("does not allow pinned inactive blocks to enter prompt context", () => {
    const candidates = [
      candidate("pinned-inbox", 2, { pinned: true, status: "inbox" }),
      candidate("pinned-archived", 2, { pinned: true, status: "archived" }),
      candidate("pinned-active", 2, { pinned: true, status: "active" }),
      candidate("regular-active", 2, { status: "active", priority: "P2" }),
    ]

    const result = selectContext(candidates, 10)
    expect(result.selected.map(({ candidate: c }) => c.block.id)).toEqual(["pinned-active", "regular-active"])
  })

  it("preserves priority and pin ordering among eligible blocks when mixed with inactive blocks", () => {
    const candidates = [
      candidate("inbox-p0", 2, { status: "inbox", priority: "P0", pinned: true }),
      candidate("active-p2", 2, { status: "active", priority: "P2" }),
      candidate("active-pinned", 2, { status: "active", pinned: true }),
      candidate("archived-p1", 2, { status: "archived", priority: "P1" }),
      candidate("active-p0", 2, { status: "active", priority: "P0" }),
    ]

    const result = selectContext(candidates, 10)
    expect(result.selected.map(({ candidate: c }) => c.block.id)).toEqual([
      "active-pinned",
      "active-p0",
      "active-p2",
    ])
    expect(result.usedTokens).toBe(6)
  })
})

