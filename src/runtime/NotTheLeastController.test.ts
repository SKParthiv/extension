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

  it("broadcasts to every registered view — all five viewIds", () => {
    const ctrl = makeController()
    const seen = new Set<string>()

    const viewIds = ["nottheleast.chat", "nottheleast.activity", "nottheleast.tools", "nottheleast.diagnostics", "nottheleast.context"]
    const disposables = viewIds.map((vid) =>
      ctrl.registerView(vid, vi.fn((_msg) => seen.add(vid))),
    )

    ctrl.postSnapshot()

    for (const vid of viewIds) {
      expect(seen.has(vid)).toBe(true)
    }
    expect(seen.size).toBe(viewIds.length)

    for (const d of disposables) d.dispose()
  })

  it("disposing Chat removes Chat even after Context has registered", () => {
    const ctrl = makeController()
    const chatMsgs: unknown[] = []
    const ctxMsgs: unknown[] = []

    const chatD = ctrl.registerView("chat", vi.fn((msg) => chatMsgs.push(msg)))
    ctrl.registerView("context", vi.fn((msg) => ctxMsgs.push(msg)))

    chatD.dispose()

    ctrl.postSnapshot()
    expect(chatMsgs.length).toBe(0)
    expect(ctxMsgs.length).toBeGreaterThan(0)
  })

  it("disposing Context does not remove Chat", () => {
    const ctrl = makeController()
    const chatMsgs: unknown[] = []
    const ctxMsgs: unknown[] = []

    ctrl.registerView("chat", vi.fn((msg) => chatMsgs.push(msg)))
    const ctxD = ctrl.registerView("context", vi.fn((msg) => ctxMsgs.push(msg)))

    ctxD.dispose()

    ctrl.postSnapshot()
    expect(chatMsgs.length).toBeGreaterThan(0)
    expect(ctxMsgs.length).toBe(0)
  })

  it("stale disposal cannot unregister a replacement registration", () => {
    const ctrl = makeController()
    const msgs1: unknown[] = []
    const msgs2: unknown[] = []

    const d1 = ctrl.registerView("chat", vi.fn((msg) => msgs1.push(msg)))
    const d2 = ctrl.registerView("chat", vi.fn((msg) => msgs2.push(msg)))

    // d1 is stale — calling it must not remove d2's registration
    d1.dispose()

    ctrl.postSnapshot()

    expect(msgs1.length).toBe(0)
    expect(msgs2.length).toBeGreaterThan(0)

    d2.dispose()
  })

  it("no snapshot is sent before ready message", () => {
    const ctrl = makeController()
    const msgs: unknown[] = []
    const fn = vi.fn((msg) => msgs.push(msg))

    // Register (simulating resolveWebviewView) — no snapshot yet
    ctrl.registerView("chat", fn)

    // No snapshot was sent during registration alone
    expect(msgs.length).toBe(0)
  })

  it("one ready message produces exactly one targeted snapshot", () => {
    const ctrl = makeController()
    const chatMsgs: unknown[] = []
    const ctxMsgs: unknown[] = []

    ctrl.registerView("chat", vi.fn((msg) => chatMsgs.push(msg)))
    ctrl.registerView("context", vi.fn((msg) => ctxMsgs.push(msg)))

    // Simulate a ready message from Chat only
    ctrl.postSnapshot("chat")

    // Chat gets all three snapshot messages
    const chatTypes = chatMsgs.map((m: any) => m.type)
    expect(chatTypes).toContain("runtimeConnection")
    expect(chatTypes).toContain("runtimeStatus")
    expect(chatTypes).toContain("telemetryUpdate")
    expect(chatTypes.length).toBe(3)

    // Context gets nothing
    expect(ctxMsgs.length).toBe(0)
  })

  it("Chat's snapshot never reaches another view", () => {
    const ctrl = makeController()
    const chatMsgs: unknown[] = []
    const ctxMsgs: unknown[] = []
    const activityMsgs: unknown[] = []

    ctrl.registerView("chat", vi.fn((msg) => chatMsgs.push(msg)))
    ctrl.registerView("context", vi.fn((msg) => ctxMsgs.push(msg)))
    ctrl.registerView("activity", vi.fn((msg) => activityMsgs.push(msg)))

    ctrl.postSnapshot("chat")

    expect(chatMsgs.length).toBeGreaterThan(0)
    expect(ctxMsgs.length).toBe(0)
    expect(activityMsgs.length).toBe(0)
  })

  it("disposing a view through VS Code disposal unregisters it", () => {
    const ctrl = makeController()
    const msgs: unknown[] = []
    const fn = vi.fn((msg) => msgs.push(msg))

    const d = ctrl.registerView("chat", fn)
    d.dispose()

    ctrl.postSnapshot()
    expect(msgs.length).toBe(0)
  })

  it("hidden views remain registered — snapshot reaches them", () => {
    const ctrl = makeController()
    const msgs: unknown[] = []
    const fn = vi.fn((msg) => msgs.push(msg))

    ctrl.registerView("chat", fn)
    // Hidden view: still registered, just not actively visible
    ctrl.postSnapshot()

    expect(msgs.length).toBeGreaterThan(0)
  })
})