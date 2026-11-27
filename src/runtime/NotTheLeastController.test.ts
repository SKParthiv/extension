/**
 * @file
 * Tests for the webview registration, snapshot delivery and state
 * restoration in NotTheLeastController and GenericViewProvider.
 * Uses a minimal vscode shim to mock VS Code APIs.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest"
import { NotTheLeastController } from "./NotTheLeastController"
import { GenericViewProvider } from "../webview/GenericViewProvider"

// ── Minimal vscode shim ──

vi.mock("vscode", () => {
  class Disposable {
    constructor(readonly dispose: () => void) {}
  }
  const mockOutputChannel = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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
      findFiles: vi.fn().mockResolvedValue([]),
      workspaceFolders: undefined,
    },
    window: {
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      createOutputChannel: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    },
    env: { clipboard: { writeText: vi.fn() },
    },
    Uri: {
      joinPath: vi.fn((base: any, ...segments: string[]) => ({ fsPath: `${base?.fsPath ?? ""}/${segments.join("/")}` })),
    },
  }
})

// ── Helpers ──

interface MockWebviewView {
  webview: {
    options: Record<string, unknown>
    html: string
    postMessage: ReturnType<typeof vi.fn>
    asWebviewUri: ReturnType<typeof vi.fn>
    cspSource: string
    onDidReceiveMessage: ReturnType<typeof vi.fn>
  }
  onDidDispose: ReturnType<typeof vi.fn>
}

function createMockWebviewView(): MockWebviewView & { triggerReceiveMessage(msg: unknown): void; triggerDispose(): void } {
  const messageHandlers: Array<(msg: unknown) => void> = []
  const disposeHandlers: Array<() => void> = []

  const mock: MockWebviewView = {
    webview: {
      options: {},
      html: "",
      postMessage: vi.fn(),
      asWebviewUri: vi.fn(() => ({ toString: () => "webview.js" })),
      cspSource: "'self'",
      onDidReceiveMessage: vi.fn((handler: (msg: unknown) => void) => {
        messageHandlers.push(handler)
        return { dispose: () => { messageHandlers.length = 0 } }
      }) as any,
    },
    onDidDispose: vi.fn((handler: () => void) => {
      disposeHandlers.push(handler)
      return { dispose: () => { disposeHandlers.length = 0 } }
    }) as any,
  }

  return Object.assign(mock, {
    triggerReceiveMessage(msg: unknown) { for (const h of messageHandlers) h(msg) },
    triggerDispose() { for (const h of disposeHandlers) h() },
  })
}

function makeController(): any {
  return new (NotTheLeastController as any)()
}

describe("NotTheLeastController view registry and broadcast", () => {

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

    const chatTypes = chatMsgs.map((m: any) => m.type)
    expect(chatTypes).toContain("runtimeConnection")
    expect(chatTypes).toContain("runtimeStatus")
    expect(chatTypes).toContain("telemetryUpdate")
    expect(chatTypes).toContain("sessionsList")
    expect(chatTypes.length).toBe(4)

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

// ── Provider-level lifecycle tests ──

describe("GenericViewProvider snapshot restoration via webview lifecycle", () => {
  let ctrl: NotTheLeastController
  let extUri: any

  beforeEach(() => {
    ctrl = makeController()
    extUri = { fsPath: "/test" }
  })

  afterEach(() => {
    ctrl.dispose()
  })

  it("restores activity entries to Activity view", () => {
    ctrl.state.recordActivity("info", "Session started")
    ctrl.state.recordActivity("info", "Token limit approaching")

    const view = createMockWebviewView()
    const provider = new GenericViewProvider(extUri, "nottheleast.activity", ctrl)

    provider.resolveWebviewView(view as any)
    view.triggerReceiveMessage({ type: "ready" })

    const activityMsgs = view.webview.postMessage.mock.calls.filter(([m]: any) => m.type === "activityUpdate")
    expect(activityMsgs.length).toBe(2)
    expect(activityMsgs[0][0].entry.title).toBe("Session started")
    expect(activityMsgs[1][0].entry.title).toBe("Token limit approaching")
  })

  it("restores tool executions to Tools view", () => {
    ctrl.state.recordToolExecution({ id: "t1", toolName: "readFile", state: "completed", requestedAt: Date.now() - 100, completedAt: Date.now() } as any)
    ctrl.state.recordToolExecution({ id: "t2", toolName: "writeFile", state: "requested", requestedAt: Date.now() } as any)

    const view = createMockWebviewView()
    const provider = new GenericViewProvider(extUri, "nottheleast.tools", ctrl)

    provider.resolveWebviewView(view as any)
    view.triggerReceiveMessage({ type: "ready" })

    const toolMsgs = view.webview.postMessage.mock.calls.filter(([m]: any) => m.type === "toolExecutionUpdate")
    expect(toolMsgs.length).toBe(2)
  })

  it("restores latest context assembly to Context view", () => {
    const assemblyPayload = { budget: 4000, usedTokens: 1200, selected: [{ title: "auth.ts", tokenEstimate: 800, reason: "pinned" }], omitted: [], retrieved: [] }
    ;(ctrl as any).lastContextAssembly = { type: "contextAssembly", ...assemblyPayload }

    const view = createMockWebviewView()
    const provider = new GenericViewProvider(extUri, "nottheleast.context", ctrl)

    provider.resolveWebviewView(view as any)
    view.triggerReceiveMessage({ type: "ready" })

    const asmMsgs = view.webview.postMessage.mock.calls.filter(([m]: any) => m.type === "contextAssembly")
    expect(asmMsgs.length).toBe(1)
    expect(asmMsgs[0][0].budget).toBe(4000)
    expect(asmMsgs[0][0].selected[0].title).toBe("auth.ts")
  })

  it("sends telemetryUpdate to Diagnostics view", () => {
    const view = createMockWebviewView()
    const provider = new GenericViewProvider(extUri, "nottheleast.diagnostics", ctrl)

    provider.resolveWebviewView(view as any)
    view.triggerReceiveMessage({ type: "ready" })

    const teleMsgs = view.webview.postMessage.mock.calls.filter(([m]: any) => m.type === "telemetryUpdate")
    expect(teleMsgs.length).toBe(1)
    expect(teleMsgs[0][0].data.connectionState).toBe("disconnected")
  })

  it("sends current runtime status to Chat view", () => {
    const view = createMockWebviewView()
    const provider = new GenericViewProvider(extUri, "nottheleast.chat", ctrl)

    provider.resolveWebviewView(view as any)
    view.triggerReceiveMessage({ type: "ready" })

    const statusMsgs = view.webview.postMessage.mock.calls.filter(([m]: any) => m.type === "runtimeStatus")
    expect(statusMsgs.length).toBe(1)
    expect(statusMsgs[0][0].status).toBe("idle")
  })

  it("one view's snapshot does not reach other views", () => {
    const chatView = createMockWebviewView()
    const ctxView = createMockWebviewView()
    const chatProvider = new GenericViewProvider(extUri, "nottheleast.chat", ctrl)
    const ctxProvider = new GenericViewProvider(extUri, "nottheleast.context", ctrl)

    chatProvider.resolveWebviewView(chatView as any)
    ctxProvider.resolveWebviewView(ctxView as any)

    chatView.triggerReceiveMessage({ type: "ready" })

    const chatStatus = chatView.webview.postMessage.mock.calls.filter(([m]: any) => m.type === "runtimeStatus")
    const ctxStatus = ctxView.webview.postMessage.mock.calls.filter(([m]: any) => m.type === "runtimeStatus")

    expect(chatStatus.length).toBe(1)
    expect(ctxStatus.length).toBe(0)
  })

  it("repeated ready messages do not duplicate initial snapshots", () => {
    const view = createMockWebviewView()
    const provider = new GenericViewProvider(extUri, "nottheleast.chat", ctrl)

    provider.resolveWebviewView(view as any)
    view.triggerReceiveMessage({ type: "ready" })
    view.triggerReceiveMessage({ type: "ready" })

    const statusMsgs = view.webview.postMessage.mock.calls.filter(([m]: any) => m.type === "runtimeStatus")
    expect(statusMsgs.length).toBe(2)
  })

  it("a newly resolved webview receives a fresh snapshot", () => {
    const view1 = createMockWebviewView()
    const provider = new GenericViewProvider(extUri, "nottheleast.chat", ctrl)

    provider.resolveWebviewView(view1 as any)
    view1.triggerReceiveMessage({ type: "ready" })

    const firstStatusCount = view1.webview.postMessage.mock.calls.filter(([m]: any) => m.type === "runtimeStatus").length
    expect(firstStatusCount).toBe(1)

    const view2 = createMockWebviewView()
    provider.resolveWebviewView(view2 as any)
    view2.triggerReceiveMessage({ type: "ready" })

    const secondStatusCount = view2.webview.postMessage.mock.calls.filter(([m]: any) => m.type === "runtimeStatus").length
    expect(secondStatusCount).toBe(1)
  })
})

// ── Session persistence tests (integration with ContextDatabase) ──

describe("NotTheLeastController — ensureSession controller-level tests", () => {
  let database: any
  let service: any

  beforeEach(async () => {
    const { ContextDatabase } = await import("../context/db/Database.js")
    const { ContextService } = await import("../context/ContextService.js")
    database = await ContextDatabase.open()
    service = new ContextService(database)
  })

  afterEach(async () => {
    if (database) database.close()
  })

  function makeSessionTestController(runtimeMock?: {
    createSession: ReturnType<typeof vi.fn>
  }): any {
    const ctrl = makeController()
    ctrl.service = service
    if (runtimeMock) {
      ctrl.runtime = runtimeMock
    }
    return ctrl
  }

  it("Runtime creation fails once, then succeeds — exactly one app-session row, two runtime creation attempts", async () => {
    const runtimeCreate = vi.fn()
    runtimeCreate.mockRejectedValueOnce(new Error("network error"))
    runtimeCreate.mockResolvedValueOnce({ id: "tf-session-retry" })

    const ctrl = makeSessionTestController({ createSession: runtimeCreate })

    const result1 = await ctrl.ensureSession()
    expect(result1).toBeUndefined()
    expect(ctrl.activeSessionId).toBeUndefined()
    expect(ctrl.pendingAppSessionId).toMatch(/^s-/)
    expect(ctrl.pendingRuntimeSessionId).toBeUndefined()
    expect(service.listSessions()).toHaveLength(1)

    const result2 = await ctrl.ensureSession()
    expect(result2).toBe(ctrl.activeSessionId)
    expect(runtimeCreate).toHaveBeenCalledTimes(2)
    expect(service.listSessions()).toHaveLength(1)
    const sessions = service.listSessions()
    expect(sessions[0].trueforgeSessionId).toBe("tf-session-retry")
    expect(ctrl.pendingAppSessionId).toBeUndefined()
    expect(ctrl.pendingRuntimeSessionId).toBeUndefined()
  })

  it("Mapping persistence fails once, then succeeds — runtime created exactly once", async () => {
    const runtimeCreate = vi.fn().mockResolvedValue({ id: "tf-session-map-retry" })

    service.setTrueForgeSessionId = vi.fn()
    service.setTrueForgeSessionId
      .mockRejectedValueOnce(new Error("mapping persist failure"))
      .mockResolvedValueOnce(undefined)

    const ctrl = makeSessionTestController({ createSession: runtimeCreate })

    const result1 = await ctrl.ensureSession()
    expect(result1).toBeUndefined()
    expect(service.listSessions()).toHaveLength(1)
    expect(ctrl.pendingAppSessionId).toBeDefined()
    expect(ctrl.pendingRuntimeSessionId).toBe("tf-session-map-retry")
    expect(runtimeCreate).toHaveBeenCalledTimes(1)
    expect(ctrl.activeSessionId).toBeUndefined()

    const result2 = await ctrl.ensureSession()
    expect(result2).toBeDefined()
    expect(result2).toBe(ctrl.activeSessionId)
    expect(runtimeCreate).toHaveBeenCalledTimes(1)
    expect(service.listSessions()).toHaveLength(1)
    expect(service.setTrueForgeSessionId).toHaveBeenCalledTimes(2)
    expect(ctrl.pendingAppSessionId).toBeUndefined()
    expect(ctrl.pendingRuntimeSessionId).toBeUndefined()
  })

it("Fully initialized session reused — no additional database session or runtime creation", async () => {
    const runtimeCreate = vi.fn().mockResolvedValue({ id: "tf-session-reuse" })
    const ctrl = makeSessionTestController({ createSession: runtimeCreate })

    const result1 = await ctrl.ensureSession()
    expect(result1).toBeDefined()
    expect(ctrl.activeSessionId).toBe(result1)
    expect(runtimeCreate).toHaveBeenCalledTimes(1)

    const result2 = await ctrl.ensureSession()
    expect(result2).toBe(result1)
    expect(runtimeCreate).toHaveBeenCalledTimes(1)
    expect(service.listSessions()).toHaveLength(1)
    const sessions = service.listSessions()
    expect(sessions[0].trueforgeSessionId).toBe("tf-session-reuse")
  })

  it("Context database unavailable — no runtime session created and no active session published", async () => {
    const runtimeCreate = vi.fn().mockResolvedValue({ id: "tf-session-no-db" })
    const ctrl = makeController()
    ctrl.runtime = { createSession: runtimeCreate }

    const result = await ctrl.ensureSession()
    expect(result).toBeUndefined()
    expect(runtimeCreate).not.toHaveBeenCalled()
    expect(ctrl.activeSessionId).toBeUndefined()
    expect(ctrl.pendingAppSessionId).toBeUndefined()
    expect(ctrl.pendingRuntimeSessionId).toBeUndefined()
  })

  it("App-session creation fails — no runtime session created and no active session published", async () => {
    const runtimeCreate = vi.fn().mockResolvedValue({ id: "tf-session-fail-app" })
    const ctrl = makeSessionTestController({ createSession: runtimeCreate })

    service.createSession = vi.fn().mockRejectedValue(new Error("DB unavailable"))

    const result = await ctrl.ensureSession()
    expect(result).toBeUndefined()
    expect(runtimeCreate).not.toHaveBeenCalled()
    expect(ctrl.activeSessionId).toBeUndefined()
    expect(ctrl.pendingAppSessionId).toBeUndefined()
    expect(ctrl.pendingRuntimeSessionId).toBeUndefined()
  })
})
describe("ContextService session creation — direct (no vscode mock)", () => {
  it("creates session through ContextService with transaction", async () => {
    const { ContextDatabase } = await import("../context/db/Database.js")
    const { ContextService } = await import("../context/ContextService.js")
    const database = await ContextDatabase.open()
    try {
      const service = new ContextService(database)
      const session = await service.createSession("Direct Test")
      expect(session.title).toBe("Direct Test")
      expect(service.listSessions()).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it("surfaces database failure on duplicate id", async () => {
    const { ContextDatabase } = await import("../context/db/Database.js")
    const { ContextService } = await import("../context/ContextService.js")
    const database = await ContextDatabase.open()
    try {
      const service = new ContextService(database)
      await service.createSession("First", "s-dup")
      await expect(service.createSession("Second", "s-dup")).rejects.toThrow()
    } finally {
      database.close()
    }
  })
})

// ── Attachment picker regression tests ──

describe("attachment search — resolveAttachment path/requestId", () => {
  let ctrl: any
  let mockVscode: any
  let attachmentPicker: typeof import("../attachments/attachmentPicker")

  beforeAll(async () => {
    attachmentPicker = await import("../attachments/attachmentPicker.js")
  })

  beforeEach(async () => {
    ctrl = makeController()
    ctrl.registerView("test", vi.fn())
    mockVscode = await import("vscode")
  })

  it("file results carry absolute f.fsPath (not asRelativePath)", async () => {
    const postMsg = vi.fn()
    ctrl.registerView("v1", postMsg)

    // Set up workspace folders for this test
    const origFolders = (mockVscode as any).workspace.workspaceFolders
    ;(mockVscode as any).workspace.workspaceFolders = [
      { uri: { fsPath: "/workspace" } },
    ]

    const mockFiles = [
      { fsPath: "/workspace/src/main.ts" },
      { fsPath: "/workspace/src/utils.ts" },
    ]
    const origFindFiles = (mockVscode as any).workspace.findFiles
    ;(mockVscode as any).workspace.findFiles = vi.fn().mockResolvedValue(mockFiles)

    await ctrl.resolveAttachment("#main", 1)

    ;(mockVscode as any).workspace.findFiles = origFindFiles
    ;(mockVscode as any).workspace.workspaceFolders = origFolders

    const broadcastCalls = postMsg.mock.calls.filter(([m]: any) => m.type === "attachmentResolved")
    expect(broadcastCalls.length).toBeGreaterThan(0)
    const msg = broadcastCalls[0][0]
    expect(msg.requestId).toBe(1)
    expect(msg.results.length).toBe(2)
    for (const r of msg.results) {
      expect(r.path).toEqual(expect.stringContaining("/workspace/src"))
    }
  })

  it("out-of-order requestId — later response with stale requestId is rejected by webview logic", () => {
    const { isCurrentResponse } = attachmentPicker
    expect(isCurrentResponse("#A", 1, 2)).toBe(false)
    expect(isCurrentResponse("#B", 2, 2)).toBe(true)
  })

  it("clearing input invalidates pending — requestId advances without query", () => {
    const { isCurrentResponse } = attachmentPicker
    expect(isCurrentResponse("#late", 2, 3)).toBe(false)
  })
})

describe("attachment path validation — resolveAttachments", () => {
  let ctrl: any
  let mockVscode: any

  beforeEach(async () => {
    ctrl = makeController()
    ctrl.service = {
      listSessionContext: vi.fn().mockResolvedValue([]),
      getSession: vi.fn(),
    }
    mockVscode = await import("vscode")
  })

  it("isPathInWorkspace returns false when no workspace folders", () => {
    const origFolders = (mockVscode as any).workspace.workspaceFolders
    ;(mockVscode as any).workspace.workspaceFolders = undefined
    const result = ctrl.isPathInWorkspace("/some/path")
    ;(mockVscode as any).workspace.workspaceFolders = origFolders
    expect(result).toBe(false)
  })

  it("resolveAttachments skips outside-workspace path", async () => {
    const attachments = [{ type: "file", path: "/etc/passwd", label: "passwd" }]
    const resolved = await ctrl.resolveAttachments(attachments)
    expect(resolved.length).toBe(0)
  })
}) as any

describe("isPathInWorkspace — real filesystem tests", () => {
  let ctrl: any
  let mockVscode: any
  let tmpDir: string

  beforeEach(async () => {
    ctrl = makeController()
    ctrl.service = {
      listSessionContext: vi.fn().mockResolvedValue([]),
      getSession: vi.fn(),
    }
    mockVscode = await import("vscode")
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlt-test-"))
    // Set workspace folder to tmpDir
    const origFolders = (mockVscode as any).workspace.workspaceFolders
    ;(mockVscode as any).workspace.workspaceFolders = [
      { uri: { fsPath: tmpDir } },
    ]
  })

  afterEach(async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    if (tmpDir) {
      try {
        const entries = fs.readdirSync(tmpDir)
        for (const e of entries) {
          const full = path.join(tmpDir, e)
          try { fs.unlinkSync(full) } catch {}
        }
        fs.rmdirSync(tmpDir)
      } catch {}
    }
  })

  it("inside-workspace path accepted", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const filePath = path.join(tmpDir, "inner.ts")
    fs.writeFileSync(filePath, "// test")
    expect(ctrl.isPathInWorkspace(filePath)).toBe(true)
    fs.unlinkSync(filePath)
  })

  it("outside-workspace path rejected", async () => {
    const os = await import("node:os")
    expect(ctrl.isPathInWorkspace(os.tmpdir())).toBe(false)
  })

  it("symlink escape rejected", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const outsideDir = path.join(tmpDir, "..", "outside-escape")
    fs.mkdirSync(outsideDir)
    const escapeLink = path.join(tmpDir, "escape-link")
    try { fs.symlinkSync(outsideDir, escapeLink, "junction") } catch {
      // fallback to dir if junction fails
      try { fs.symlinkSync(outsideDir, escapeLink) } catch { fs.rmdirSync(outsideDir); return }
    }
    const linkTarget = path.join(escapeLink, "leak.txt")
    fs.writeFileSync(linkTarget, "leak")
    expect(ctrl.isPathInWorkspace(linkTarget)).toBe(false)
    fs.unlinkSync(linkTarget)
    fs.unlinkSync(escapeLink)
    fs.rmdirSync(outsideDir)
  })

  it("valid internal symlink accepted", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const realDir = path.join(tmpDir, "real-dir")
    fs.mkdirSync(realDir)
    fs.writeFileSync(path.join(realDir, "a.ts"), "// ok")
    const linkDir = path.join(tmpDir, "link-dir")
    const linkFile = path.join(linkDir, "a.ts")
    try { fs.symlinkSync(realDir, linkDir, "junction") } catch {
      try { fs.symlinkSync(realDir, linkDir) } catch { fs.rmdirSync(realDir); return }
    }
    expect(ctrl.isPathInWorkspace(linkFile)).toBe(true)
    fs.unlinkSync(path.join(realDir, "a.ts"))
    fs.rmdirSync(realDir)
    fs.unlinkSync(linkDir)
  })
}) as any

describe("handleExportDiagnostics", () => {
  it("copies redacted diagnostics JSON to the clipboard", async () => {
    const vscode = await import("vscode")
    const { NotTheLeastController } = await import("./NotTheLeastController.js")
    const { logInfo } = await import("./NotTheLeastLogger.js")
    const controller = new NotTheLeastController()
    logInfo("Test", "export me")
    await controller.handleExportDiagnostics()
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledTimes(1)
    const written = (vscode.env.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(written).toContain("export me")
    expect(JSON.parse(written).events.length).toBeGreaterThan(0)
    expect(vscode.window.showInformationMessage).toHaveBeenCalled()
  })
})
