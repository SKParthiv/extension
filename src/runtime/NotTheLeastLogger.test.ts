import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}))

import { clearDiagnosticEvents, exportDiagnosticsJson, getDiagnosticEvents, logError, logWarn } from "./NotTheLeastLogger"

describe("NotTheLeastLogger", () => {
  beforeEach(() => {
    clearDiagnosticEvents()
  })

  it("redacts bearer tokens in logged messages", () => {
    logError("Runtime", "request failed with Bearer abcdefghijklmnopqrstuvwxyz123456")
    const event = getDiagnosticEvents().at(-1)
    expect(event?.level).toBe("error")
    expect(event?.message).toContain("Bearer [REDACTED]")
    expect(event?.message).not.toContain("abcdefghijklmnopqrstuvwxyz123456")
  })

  it("keeps known context fields and folds unknown extras into details", () => {
    logWarn("Prompt", "attachment not resolved", {
      sessionId: "s-1",
      path: "missing.ts",
      message: "file not found",
    })
    const event = getDiagnosticEvents().at(-1)
    expect(event?.sessionId).toBe("s-1")
    expect(event?.details).toContain("path=missing.ts")
    expect(event?.details).toContain("message=file not found")
  })

  it("exports the ring buffer as valid JSON with an export timestamp", () => {
    logWarn("Test", "one")
    logWarn("Test", "two")
    const parsed = JSON.parse(exportDiagnosticsJson()) as { events: unknown[]; exportedAt: string }
    expect(parsed.events).toHaveLength(2)
    expect(parsed.exportedAt).toBeTruthy()
  })

  it("caps the buffer at 500 events", () => {
    for (let index = 0; index < 505; index += 1) {
      logWarn("Test", `event ${index}`)
    }
    expect(getDiagnosticEvents()).toHaveLength(500)
    expect(getDiagnosticEvents()[0].message).toBe("event 5")
  })
})
