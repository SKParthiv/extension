/**
 * @file
 * Tests for the webview registration and snapshot delivery
 * in NotTheLeastController. Relies on a minimal vscode shim
 * that provides just enough surface for the Map-based
 * view registry and broadcast path.
 */

import { describe, it, expect, vi } from "vitest"
import { NotTheLeastController } from "./NotTheLeastController"

// ── Minimal vscode shim for the controller's public surface ──
vi.mock("vscode", () => {
  class Disposable {
    constructor(readonly dispose: () => void) {}
  }
  return {
    Disposable,
    EventEmitter: class {
      event = vi.fn()
    },
    workspace: {
      getConfiguration() {
        return { get: vi.fn(() => "") }
      },
    },
    window: {
      showErrorMessage: vi.fn(),
    },
    Uri: {
      joinPath: vi.fn((base: any, ...segments: string[]) => ({ fsPath: `${base?.fsPath ?? ""}/${segments.join("/")}` })),
    },
  }
})

describe("NotTheLeastController view registry and broadcast", () => {
  function makeController(): NotTheLeastController {
    return new (NotTheLeastController as any)()
  }

  it("broadcasts to every registered view", () => {
    const ctrl = makeController()
    const received: string[] = []

    const d1 = ctrl.registerView("view-a", vi.fn((msg) => received.push("a")))
    const d2 = ctrl.registerView("view-b", vi.fn((msg) => received.push("b")))

    // Trigger a snapshot broadcast (covers broadcast internally)
    ctrl.postSnapshot()

    expect(received).toContain("a")
    expect(received).toContain("b")

    d1.dispose()
    d2.dispose()
  })

  it("sends snapshot only to the requested viewId", () => {
    const ctrl = makeController()
    const aMsgs: unknown[] = []
    const bMsgs: unknown[] = []

    ctrl.registerView("view-a", vi.fn((msg) => aMsgs.push(msg)))
    ctrl.registerView("view-b", vi.fn((msg) => bMsgs.push(msg)))

    ctrl.postSnapshot("view-a")

    expect(aMsgs.length).toBeGreaterThan(0)
    expect(bMsgs.length).toBe(0)
  })

  it("sends snapshot only to context when requested", () => {
    const ctrl = makeController()
    const ctxMsgs: unknown[] = []
    const chatMsgs: unknown[] = []

    ctrl.registerView("nottheleast.context", vi.fn((msg) => ctxMsgs.push(msg)))
    ctrl.registerView("nottheleast.chat", vi.fn((msg) => chatMsgs.push(msg)))

    ctrl.postSnapshot("nottheleast.context")

    expect(ctxMsgs.length).toBeGreaterThan(0)
    expect(chatMsgs.length).toBe(0)
  })

  it("stops message delivery after disposal", () => {
    const ctrl = makeController()
    const msgs: unknown[] = []
    const fn = vi.fn((msg) => msgs.push(msg))

    const d = ctrl.registerView("chat", fn)
    d.dispose()

    ctrl.postSnapshot()
    expect(msgs.length).toBe(0)
  })

  it("re-registering a view does not let old disposable unregister the new registration", () => {
    const ctrl = makeController()
    const msgs1: unknown[] = []
    const msgs2: unknown[] = []

    const d1 = ctrl.registerView("chat", vi.fn((msg) => msgs1.push(msg)))
    const d2 = ctrl.registerView("chat", vi.fn((msg) => msgs2.push(msg)))

    // Dispose the old registration — it should NOT remove the new one
    d1.dispose()

    ctrl.postSnapshot()

    // Only the second registration should have received messages
    expect(msgs1.length).toBe(0)
    expect(msgs2.length).toBeGreaterThan(0)

    d2.dispose()
  })

  it("sends exactly one snapshot on registration, no duplicate on ready", () => {
    const ctrl = makeController()
    const msgs: unknown[] = []
    const fn = vi.fn((msg) => msgs.push(msg))

    // Simulate what GenericViewProvider does: register then pass viewId to postSnapshot
    const d = ctrl.registerView("chat", fn)
    ctrl.postSnapshot("chat")

    // Count distinct messages: there should be 3 (runtimeConnection, runtimeStatus, telemetryUpdate)
    // and no duplicates of any single type
    const types = msgs.map((m: any) => m.type)
    const counts: Record<string, number> = {}
    for (const t of types) counts[t] = (counts[t] ?? 0) + 1

    expect(counts["runtimeConnection"]).toBe(1)
    expect(counts["runtimeStatus"]).toBe(1)
    expect(counts["telemetryUpdate"]).toBe(1)

    d.dispose()
  })
})