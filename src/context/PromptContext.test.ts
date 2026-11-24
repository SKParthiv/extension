import { describe, expect, it } from "vitest"
import { attachmentTokenEstimate, formatPromptWithContext } from "./PromptContext"
import { assembleContext } from "./ContextAssembler"
import type { ContextCandidate } from "./ContextSelector"
import type { ContextStatus } from "./ContextService"

function candidate(title: string, content: string): ContextCandidate {
  return {
    block: {
      id: `block-${title}`,
      title,
      content,
      sourceType: "user",
      provenance: "test",
      parentBlockId: null,
      tokenEstimate: Math.ceil(content.length / 4),
      originalRef: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    membership: {
      sessionId: "session-1",
      blockId: `block-${title}`,
      scope: "task",
      priority: null,
      status: "active",
      position: 0,
      pinned: false,
      locked: false,
    },
  }
}

describe("attachmentTokenEstimate", () => {
  it("estimates four characters per token, rounding up", () => {
    expect(attachmentTokenEstimate("abcd")).toBe(1)
    expect(attachmentTokenEstimate("abcde")).toBe(2)
    expect(attachmentTokenEstimate("")).toBe(0)
  })
})

describe("formatPromptWithContext", () => {
  it("returns the bare prompt when nothing is attached or assembled", () => {
    const prompt = "fix the login bug"
    expect(formatPromptWithContext(prompt, { selected: [], retrieved: [] })).toBe(prompt)
  })

  it("appends selected context blocks inside a context section", () => {
    const assembly = {
      selected: [{ candidate: candidate("Auth rules", "Never bypass approval") }],
      retrieved: [],
    }
    const result = formatPromptWithContext("review my plan", assembly)
    expect(result).toContain("review my plan\n\n<context>")
    expect(result).toContain("### Auth rules\nNever bypass approval")
    expect(result).toMatch(/<\/context>$/)
  })

  it("appends retrieved evidence with path and line range", () => {
    const assembly = {
      selected: [],
      retrieved: [{ path: "src/app.ts", text: "export function main() {}", startLine: 10, endLine: 14 }],
    }
    const result = formatPromptWithContext("explain this", assembly)
    expect(result).toContain("### src/app.ts:10-14\nexport function main() {}")
  })

  it("appends resolved attachments with label, type, path and line range", () => {
    const assembly = { selected: [], retrieved: [] }
    const result = formatPromptWithContext("use this", assembly, [
      {
        type: "symbol",
        path: "src/auth.ts",
        label: "login",
        startLine: 3,
        endLine: 7,
        content: "function login() {}",
      },
    ])
    expect(result).toContain("### login (symbol src/auth.ts:3-7)\nfunction login() {}")
  })

  it("joins selected, retrieved and attached sections in order", () => {
    const assembly = {
      selected: [{ candidate: candidate("Rules", "rule text") }],
      retrieved: [{ path: "a.ts", text: "a text", startLine: 1, endLine: 2 }],
    }
    const result = formatPromptWithContext("do it", assembly, [
      { type: "file", path: "notes.md", label: "notes", content: "attached text" },
    ])
    const selectedAt = result.indexOf("### Rules")
    const retrievedAt = result.indexOf("### a.ts:1-2")
    const attachedAt = result.indexOf("### notes (file notes.md)")
    expect(selectedAt).toBeGreaterThan(-1)
    expect(retrievedAt).toBeGreaterThan(selectedAt)
    expect(attachedAt).toBeGreaterThan(retrievedAt)
  })

  it("proves inbox and other inactive blocks cannot enter prompt context through context assembly", () => {
    const inactiveStatuses: ContextStatus[] = ["inbox", "deferred", "archived", "excluded", "resolved"]
    const candidates: ContextCandidate[] = [
      candidate("Active rule", "active instructions"),
      ...inactiveStatuses.map((status) => {
        const c = candidate(`Inactive ${status}`, `content for ${status}`)
        c.membership.status = status
        c.membership.pinned = true
        return c
      }),
    ]

    const assembly = assembleContext({ candidates, budget: 100 })
    const prompt = formatPromptWithContext("implement feature", assembly)

    expect(prompt).toContain("### Active rule\nactive instructions")
    for (const status of inactiveStatuses) {
      expect(prompt).not.toContain(`Inactive ${status}`)
      expect(prompt).not.toContain(`content for ${status}`)
    }
  })
})
