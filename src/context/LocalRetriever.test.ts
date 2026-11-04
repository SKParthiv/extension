import { describe, expect, it } from "vitest"
import { retrieveLocalText } from "./LocalRetriever"

describe("retrieveLocalText", () => {
  it("ranks bounded snippets by deterministic query-term matches", () => {
    const results = retrieveLocalText("context service", [
      { path: "z.ts", content: "context only" },
      { path: "a.ts", content: "ContextService stores context blocks and service state." },
      { path: "none.ts", content: "unrelated" },
    ])
    expect(results.map((result) => result.path)).toEqual(["a.ts", "z.ts"])
    expect(results[0]).toMatchObject({
      reason: "Matched 2 of 2 query terms.",
      startLine: 1,
      endLine: 1,
    })
  })

  it("caps output and rejects invalid limits", () => {
    const results = retrieveLocalText(
      "needle",
      [
        { path: "a.ts", content: "needle ".repeat(100) },
        { path: "b.ts", content: "needle" },
      ],
      { maxFiles: 1, maxResults: 1, maxCharsPerFile: 20 },
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.text.length).toBeLessThanOrEqual(20)
    expect(() => retrieveLocalText("needle", [], { maxFiles: 0 })).toThrow()
  })
})

