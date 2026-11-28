/**
 * @file
 * Regression tests for the attachment picker pure helpers.
 * Covers stale-response rejection, bare-prefix handling, debounce
 * contract (via isCurrentResponse), and existing dedup/removal/range behavior.
 */
import { describe, it, expect } from "vitest"
import {
  attachmentKey,
  addAttachment,
  removeAttachment,
  toAttachmentResult,
  isCurrentResponse,
  isSearchableQuery,
  isBarePrefix,
  queryMode,
  attachmentLocation,
} from "./attachmentPicker"
import type { Attachment } from "./attachmentPicker"

// ── Existing behavior: dedup, removal, ranges ──

describe("attachmentKey", () => {
  it("file key is type:path", () => {
    expect(attachmentKey({ type: "file", path: "/a/b.ts", label: "b.ts" })).toBe("file:/a/b.ts")
  })

  it("symbol key includes path and line range", () => {
    expect(attachmentKey({ type: "symbol", path: "/a/b.ts", label: "Foo", startLine: 10, endLine: 20 }))
      .toBe("symbol:/a/b.ts:10-20")
  })

  it("symbol key uses startLine when endLine is missing", () => {
    expect(attachmentKey({ type: "symbol", path: "/a/b.ts", label: "Foo", startLine: 5 }))
      .toBe("symbol:/a/b.ts:5-5")
  })

  it("same path same key — dedup works", () => {
    const a: Attachment = { type: "file", path: "/x.ts", label: "x.ts" }
    const b: Attachment = { type: "file", path: "/x.ts", label: "x.ts" }
    expect(attachmentKey(a)).toBe(attachmentKey(b))
  })
})

describe("addAttachment", () => {
  it("appends unique attachment", () => {
    const list: Attachment[] = [{ type: "file", path: "/a.ts", label: "a.ts" }]
    const next: Attachment = { type: "file", path: "/b.ts", label: "b.ts" }
    expect(addAttachment(list, next)).toEqual([...list, next])
  })

  it("rejects duplicate by key", () => {
    const list: Attachment[] = [{ type: "file", path: "/a.ts", label: "a.ts" }]
    const dup: Attachment = { type: "file", path: "/a.ts", label: "a.ts" }
    expect(addAttachment(list, dup)).toBe(list)
  })

  it("allows same name different type", () => {
    const a: Attachment = { type: "file", path: "/x.ts", label: "x.ts" }
    const b: Attachment = { type: "symbol", path: "/x.ts", label: "x.ts", startLine: 1, endLine: 10 }
    expect(addAttachment([a], b)).toEqual([a, b])
  })
})

describe("removeAttachment", () => {
  it("removes by index", () => {
    const list: Attachment[] = [
      { type: "file", path: "/a.ts", label: "a.ts" },
      { type: "file", path: "/b.ts", label: "b.ts" },
    ]
    expect(removeAttachment(list, 0)).toEqual([list[1]])
  })

  it("returns same list for out-of-range index", () => {
    const list: Attachment[] = [{ type: "file", path: "/a.ts", label: "a.ts" }]
    expect(removeAttachment(list, -1)).toBe(list)
    expect(removeAttachment(list, 5)).toBe(list)
  })
})

describe("toAttachmentResult", () => {
  it("adds stable key to attachment", () => {
    const a: Attachment = { type: "file", path: "/x.ts", label: "x.ts" }
    const r = toAttachmentResult(a)
    expect(r.key).toBe("file:/x.ts")
    expect(r.type).toBe("file")
    expect(r.path).toBe("/x.ts")
  })
})

describe("attachmentLocation", () => {
  it("returns path for files", () => {
    expect(attachmentLocation({ type: "file", path: "/a/b.ts", label: "b.ts" })).toBe("/a/b.ts")
  })

  it("returns path:startLine-endLine for symbols with range", () => {
    expect(attachmentLocation({ type: "symbol", path: "/a/b.ts", label: "Foo", startLine: 10, endLine: 20 }))
      .toBe("/a/b.ts:10-20")
  })

  it("falls back startLine for symbol when endLine missing", () => {
    expect(attachmentLocation({ type: "symbol", path: "/a/b.ts", label: "Foo", startLine: 5 }))
      .toBe("/a/b.ts:5-5")
  })
})

// ── Query helpers ──

describe("queryMode", () => {
  it("returns 'file' for # prefix", () => {
    expect(queryMode("#foo")).toBe("file")
  })
  it("returns 'symbol' for @ prefix", () => {
    expect(queryMode("@bar")).toBe("symbol")
  })
  it("returns null for no prefix", () => {
    expect(queryMode("foo")).toBeNull()
  })
})

describe("isSearchableQuery", () => {
  it("true for # with content", () => {
    expect(isSearchableQuery("#foo")).toBe(true)
  })
  it("false for bare #", () => {
    expect(isSearchableQuery("#")).toBe(false)
  })
  it("false for bare @", () => {
    expect(isSearchableQuery("@")).toBe(false)
  })
  it("false for no prefix", () => {
    expect(isSearchableQuery("foo")).toBe(false)
  })
})

describe("isBarePrefix", () => {
  it("true for bare #", () => {
    expect(isBarePrefix("#")).toBe(true)
  })
  it("true for bare @", () => {
    expect(isBarePrefix("@")).toBe(true)
  })
  it("false for # with content", () => {
    expect(isBarePrefix("#foo")).toBe(false)
  })
  it("false for empty string", () => {
    expect(isBarePrefix("")).toBe(false)
  })
  // ── Whitespace-only prefixes ──
  it("true for '# ' (hash + space)", () => {
    expect(isBarePrefix("# ")).toBe(true)
  })
  it("true for '@ ' (at + space)", () => {
    expect(isBarePrefix("@ ")).toBe(true)
  })
  it("true for '#  ' (hash + multiple spaces)", () => {
    expect(isBarePrefix("#  ")).toBe(true)
  })
  it("true for '@  ' (at + multiple spaces)", () => {
    expect(isBarePrefix("@  ")).toBe(true)
  })
  it("false for '#x ' (hash + content + trailing space)", () => {
    expect(isBarePrefix("#x ")).toBe(false)
  })
})

// ── Stale response rejection ──

describe("isCurrentResponse", () => {
  it("accepts matching requestId", () => {
    expect(isCurrentResponse("#foo", 5, 5)).toBe(true)
  })

  it("rejects mismatched requestId", () => {
    expect(isCurrentResponse("#foo", 4, 5)).toBe(false)
  })

  it("rejects when response is from earlier request (A → B → A scenario)", () => {
    // Simulates: user types A (reqId=1), then B (reqId=2),
    // then response for B arrives (reqId=2, latest=2) ✓,
    // then response for A arrives (reqId=1, latest=2) → reject
    expect(isCurrentResponse("#A", 1, 2)).toBe(false)
  })

  it("accepts latest response after quick typing settles", () => {
    // After user pauses: latest is 3, response for 3 should match
    expect(isCurrentResponse("#final", 3, 3)).toBe(true)
  })

  it("rejects when input is cleared (requestId incremented)", () => {
    // Clearing input increments requestId without sending a query.
    // A late response for old reqId must be rejected.
    expect(isCurrentResponse("#stale", 2, 5)).toBe(false)
  })
})