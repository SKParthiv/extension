import { describe, expect, it } from "vitest"
import { assembleContext } from "./ContextAssembler"
import type { ContextCandidate } from "./ContextSelector"

function candidate(id: string, content: string, tokenEstimate: number): ContextCandidate {
  return {
    block: {
      id,
      title: id,
      content,
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
    },
  }
}

describe("assembleContext", () => {
  it("returns selected blocks, omissions, conflicts and retrieval with explanations", () => {
    const result = assembleContext({
      candidates: [candidate("one", "framework: Flask", 3), candidate("two", "framework: FastAPI", 3)],
      budget: 3,
      query: "router",
      files: [{ path: "src/router.ts", content: "router implementation" }],
    })

    expect(result.budget).toBe(3)
    expect(result.selected.map(({ candidate: item }) => item.block.id)).toEqual(["one"])
    expect(result.omitted.map(({ candidate: item }) => item.block.id)).toEqual(["two"])
    expect(result.conflicts[0]).toMatchObject({ key: "framework", reason: "different-values" })
    expect(result.retrieved[0]).toMatchObject({ path: "src/router.ts", reason: "Matched 1 of 1 query terms." })
  })

  it("does not retrieve workspace text when no query is supplied", () => {
    expect(
      assembleContext({
        candidates: [],
        budget: 100,
        files: [{ path: "secret.txt", content: "not searched" }],
      }).retrieved,
    ).toEqual([])
  })
})

