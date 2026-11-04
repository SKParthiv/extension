import { describe, expect, it } from "vitest"
import { detectConflicts } from "./ContextConflicts"
import type { ContextCandidate } from "./ContextSelector"

function candidate(id: string, content: string): ContextCandidate {
  return {
    block: {
      id,
      title: id,
      content,
      sourceType: "user",
      provenance: "test",
      parentBlockId: null,
      tokenEstimate: 1,
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
    },
  }
}

describe("detectConflicts", () => {
  it("reports same-key disagreements without changing either candidate", () => {
    const left = candidate("left", "framework: Flask\nKeep API stable.")
    const right = candidate("right", "framework: FastAPI")
    const conflicts = detectConflicts([right, left])

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      key: "framework",
      reason: "different-values",
      left: { block: { id: "left" } },
      right: { block: { id: "right" } },
    })
    expect(left.block.content).toBe("framework: Flask\nKeep API stable.")
    expect(right.block.content).toBe("framework: FastAPI")
  })

  it("ignores unstructured prose and equal values", () => {
    expect(
      detectConflicts([
        candidate("one", "Use the existing API."),
        candidate("two", "framework: Flask"),
        candidate("three", "framework: Flask"),
      ]),
    ).toEqual([])
  })
})

