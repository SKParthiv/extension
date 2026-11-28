import { describe, expect, it, vi } from "vitest"
import { ContextDatabase } from "./db/Database"
import { ContextService } from "./ContextService"
import { NotTheLeastController } from "../runtime/NotTheLeastController"
import type { ExtensionToWebviewMessage } from "../shared/messages"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"

vi.mock("vscode", () => {
  return {
    Disposable: class {
      constructor(readonly dispose: () => void) {}
    },
    workspace: {
      getConfiguration() {
        return { get: vi.fn(() => "") }
      },
    },
    window: {
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      createOutputChannel: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    },
    env: { clipboard: { writeText: vi.fn() } },
    Uri: {
      joinPath: vi.fn((base: any, ...segments: string[]) => ({ fsPath: `${base?.fsPath ?? ""}/${segments.join("/")}` })),
    },
  }
})

describe("P04 — Session Management & Persistence", () => {
  async function createMockRuntime(onCreateSession?: () => Promise<{ id: string }>) {
    let callCount = 0
    return {
      callCount: () => callCount,
      createSession: vi.fn(async () => {
        callCount++
        if (onCreateSession) return await onCreateSession()
        return { id: `tf-sess-${callCount}` }
      }),
      sendTurn: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      respondToApproval: vi.fn(async () => {}),
      onEvent: vi.fn(),
    }
  }

  function attachController(service: ContextService, database: ContextDatabase) {
    const ctrl = new NotTheLeastController()
    ;(ctrl as any).service = service
    ;(ctrl as any).database = database
    return ctrl
  }

  it("creates named application sessions with matching TrueForge IDs and persists mapping", async () => {
    const database = await ContextDatabase.open()
    const service = new ContextService(database)
    const ctrl = attachController(service, database)

    const mockRuntime = await createMockRuntime()
    ;(ctrl as any).runtime = mockRuntime

    const broadcasted: ExtensionToWebviewMessage[] = []
    ctrl.registerView("test.view", (msg) => broadcasted.push(msg as any))

    const newAppId = await ctrl.handleCreateSession("Feature Plan")
    expect(newAppId).toBeDefined()
    expect(newAppId).toMatch(/^s-/)

    const sess = service.getSession(newAppId!)
    expect(sess).toBeDefined()
    expect(sess?.title).toBe("Feature Plan")
    expect(sess?.trueforgeSessionId).toBe("tf-sess-1")

    expect((ctrl as any).runtimeSessionIds.get(newAppId)).toBe("tf-sess-1")
    expect((ctrl as any).activeSessionId).toBe(newAppId)

    const changed = broadcasted.find((m) => m.type === "sessionChanged") as any
    expect(changed).toBeDefined()
    expect(changed.sessionId).toBe(newAppId)

    const listMsg = broadcasted.find((m) => m.type === "sessionsList") as any
    expect(listMsg).toBeDefined()
    expect(listMsg.activeSessionId).toBe(newAppId)
    expect(listMsg.sessions.some((s: any) => s.id === newAppId && s.title === "Feature Plan" && s.ready === true)).toBe(true)
  })

  it("renames sessions with non-empty validation and updates timestamps while preserving mappings", async () => {
    const database = await ContextDatabase.open()
    const service = new ContextService(database)
    const ctrl = attachController(service, database)

    const app = await service.createSession("Original Title", "s-orig")
    await service.setTrueForgeSessionId(app.id, "tf-orig")
    ;(ctrl as any).runtimeSessionIds.set(app.id, "tf-orig")
    ;(ctrl as any).activeSessionId = app.id

    const broadcasted: ExtensionToWebviewMessage[] = []
    ctrl.registerView("test.view", (msg) => broadcasted.push(msg as any))

    await ctrl.handleRenameSession(app.id, "   ")
    expect(broadcasted.some((m) => m.type === "error" && m.message.includes("cannot be empty"))).toBe(true)

    await ctrl.handleRenameSession(app.id, "Renamed Title")
    const updated = service.getSession(app.id)
    expect(updated?.title).toBe("Renamed Title")
    expect(updated?.trueforgeSessionId).toBe("tf-orig")
    expect(updated?.id).toBe(app.id)
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(app.updatedAt).getTime())
  })

  it("switches sessions, validates existence, rejects unknown IDs and preserves context isolation", async () => {
    const database = await ContextDatabase.open()
    const service = new ContextService(database)
    const ctrl = attachController(service, database)

    const s1 = await service.createSession("Session Alpha", "s-alpha")
    const s2 = await service.createSession("Session Beta", "s-beta")
    await service.setTrueForgeSessionId(s1.id, "tf-alpha")
    await service.setTrueForgeSessionId(s2.id, "tf-beta")

    await service.create({
      sessionId: s1.id,
      title: "Alpha Secret",
      content: "Alpha Content",
      sourceType: "user",
      provenance: "test",
    })

    const broadcasted: ExtensionToWebviewMessage[] = []
    ctrl.registerView("test.view", (msg) => broadcasted.push(msg as any))

    await ctrl.handleSelectSession("s-nonexistent")
    expect(broadcasted.some((m) => m.type === "error" && m.message.includes("Cannot switch to unknown session"))).toBe(true)

    await ctrl.handleSelectSession(s2.id)
    expect((ctrl as any).activeSessionId).toBe(s2.id)

    const snap = ctrl.getContextSnapshotSync()
    expect(snap?.activeSessionId).toBe(s2.id)
    expect(snap?.blocks.length).toBe(0)

    await ctrl.handleSelectSession(s1.id)
    expect((ctrl as any).activeSessionId).toBe(s1.id)
    const snap1 = ctrl.getContextSnapshotSync()
    expect(snap1?.activeSessionId).toBe(s1.id)
    expect(snap1?.blocks.length).toBe(1)
    expect(snap1?.blocks[0].title).toBe("Alpha Secret")
  })

  it("persists application-to-TrueForge mappings across database reopen without duplicate creation", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-p04-"))
    const dbPath = path.join(tmpDir, "context.sqlite")

    try {
      const db1 = await ContextDatabase.open({ filePath: dbPath })
      const service1 = new ContextService(db1)
      const app1 = await service1.createSession("Persisted Session", "s-p1")
      await service1.setTrueForgeSessionId(app1.id, "tf-p1")
      await db1.save()
      db1.close()

      const db2 = await ContextDatabase.open({ filePath: dbPath })
      const service2 = new ContextService(db2)
      const ctrl = attachController(service2, db2)
      ctrl.hydratePersistedSessions()

      expect((ctrl as any).runtimeSessionIds.get("s-p1")).toBe("tf-p1")
      expect((ctrl as any).activeSessionId).toBe("s-p1")

      const mockRuntime = await createMockRuntime()
      ;(ctrl as any).runtime = mockRuntime

      await ctrl.handleSelectSession("s-p1")
      expect(mockRuntime.callCount()).toBe(0)
      expect((ctrl as any).runtimeSessionIds.get("s-p1")).toBe("tf-p1")

      db2.close()
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("restores last active application session after reopen", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-p04-last-"))
    const dbPath = path.join(tmpDir, "context.sqlite")

    try {
      const db1 = await ContextDatabase.open({ filePath: dbPath })
      const service1 = new ContextService(db1)
      const ctrl1 = attachController(service1, db1)
      const first = await service1.createSession("First", "s-first")
      const second = await service1.createSession("Second", "s-second")
      await service1.setTrueForgeSessionId(first.id, "tf-first")
      await service1.setTrueForgeSessionId(second.id, "tf-second")
      ;(ctrl1 as any).runtimeSessionIds.set(first.id, "tf-first")
      ;(ctrl1 as any).runtimeSessionIds.set(second.id, "tf-second")
      await ctrl1.handleSelectSession(first.id)
      db1.close()

      const db2 = await ContextDatabase.open({ filePath: dbPath })
      const service2 = new ContextService(db2)
      const ctrl2 = attachController(service2, db2)
      ctrl2.hydratePersistedSessions()
      expect((ctrl2 as any).activeSessionId).toBe(first.id)
      expect((ctrl2 as any).runtimeSessionIds.get(first.id)).toBe("tf-first")
      expect((ctrl2 as any).runtimeSessionIds.get(second.id)).toBe("tf-second")
      db2.close()
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("rejects session switching or session creation during an active running turn", async () => {
    const database = await ContextDatabase.open()
    const service = new ContextService(database)
    const ctrl = attachController(service, database)

    const s1 = await service.createSession("Session 1", "s-1")
    const s2 = await service.createSession("Session 2", "s-2")
    ;(ctrl as any).activeSessionId = s1.id

    ctrl.state.setRunning(true)

    const broadcasted: ExtensionToWebviewMessage[] = []
    ctrl.registerView("test.view", (msg) => broadcasted.push(msg as any))

    await ctrl.handleSelectSession(s2.id)
    expect((ctrl as any).activeSessionId).toBe(s1.id)
    expect(broadcasted.some((m) => m.type === "error" && m.message.includes("Cannot switch sessions while a turn is actively running"))).toBe(true)

    const created = await ctrl.handleCreateSession("Disallowed Session")
    expect(created).toBeUndefined()
    expect(broadcasted.some((m) => m.type === "error" && m.message.includes("Cannot create session while a turn is actively running"))).toBe(true)
  })

  it("rejects session switching while tool approvals are pending", async () => {
    const database = await ContextDatabase.open()
    const service = new ContextService(database)
    const ctrl = attachController(service, database)

    const s1 = await service.createSession("Session 1", "s-1")
    const s2 = await service.createSession("Session 2", "s-2")
    ;(ctrl as any).activeSessionId = s1.id
    ;(ctrl as any).pendingApprovals.set("thread:tool", {
      appSessionId: s1.id,
      runtimeSessionId: "tf-1",
      threadId: "thread",
      toolCallId: "tool",
    })

    const broadcasted: ExtensionToWebviewMessage[] = []
    ctrl.registerView("test.view", (msg) => broadcasted.push(msg as any))

    await ctrl.handleSelectSession(s2.id)
    expect((ctrl as any).activeSessionId).toBe(s1.id)
    expect(broadcasted.some((m) => m.type === "error" && m.message.includes("Cannot switch sessions while tool approvals are pending"))).toBe(true)
    expect((ctrl as any).pendingApprovals.size).toBe(1)
  })

  it("scopes runtime events to originating application session and keeps chat streams isolated", async () => {
    const database = await ContextDatabase.open()
    const service = new ContextService(database)
    const ctrl = attachController(service, database)

    const s1 = await service.createSession("Session 1", "s-1")
    const s2 = await service.createSession("Session 2", "s-2")
    await service.setTrueForgeSessionId(s1.id, "tf-1")
    await service.setTrueForgeSessionId(s2.id, "tf-2")
    ;(ctrl as any).runtimeSessionIds.set(s1.id, "tf-1")
    ;(ctrl as any).runtimeSessionIds.set(s2.id, "tf-2")
    ;(ctrl as any).activeSessionId = s2.id

    const broadcasted: ExtensionToWebviewMessage[] = []
    ctrl.registerView("test.view", (msg) => broadcasted.push(msg as any))

    ;(ctrl as any).onRuntimeEvent({
      type: "model.message.delta",
      sessionId: "tf-1",
      text: "hello session 1",
    })
    ;(ctrl as any).onRuntimeEvent({
      type: "model.message.delta",
      sessionId: "tf-2",
      text: "hello session 2",
    })

    const deltas = broadcasted
      .filter((m): m is Extract<ExtensionToWebviewMessage, { type: "assistantDelta" }> => m.type === "assistantDelta")
      .map((m) => ({ sessionId: m.sessionId, text: m.text }))
    expect(deltas).toEqual([
      { sessionId: "s-1", text: "hello session 1" },
      { sessionId: "s-2", text: "hello session 2" },
    ])
  })

  it("keeps recoverable application session when TrueForge init fails and retries without a duplicate app row", async () => {
    const database = await ContextDatabase.open()
    const service = new ContextService(database)
    const ctrl = attachController(service, database)

    let attempts = 0
    const mockRuntime = await createMockRuntime(async () => {
      attempts++
      if (attempts === 1) throw new Error("network error")
      return { id: "tf-retry" }
    })
    ;(ctrl as any).runtime = mockRuntime

    const broadcasted: ExtensionToWebviewMessage[] = []
    ctrl.registerView("test.view", (msg) => broadcasted.push(msg as any))

    const appId = await ctrl.handleCreateSession("Retry Me")
    expect(appId).toBeDefined()
    expect(service.getSession(appId!)?.trueforgeSessionId).toBeNull()
    expect(service.listSessions()).toHaveLength(1)
    expect(broadcasted.some((m) => m.type === "error" && m.message.includes("Runtime session initialization failed"))).toBe(true)
    expect(broadcasted.some((m) => m.type === "sessionsList" && (m as any).sessions.some((s: any) => s.id === appId && s.ready === false))).toBe(true)

    await ctrl.handleSelectSession(appId!)
    expect(service.getSession(appId!)?.trueforgeSessionId).toBe("tf-retry")
    expect((ctrl as any).runtimeSessionIds.get(appId)).toBe("tf-retry")
    expect(service.listSessions()).toHaveLength(1)
    expect(mockRuntime.callCount()).toBe(2)
  })

  it("serializes concurrent session creates so both persist with distinct TrueForge mappings", async () => {
    const database = await ContextDatabase.open()
    const service = new ContextService(database)
    const ctrl = attachController(service, database)
    const mockRuntime = await createMockRuntime()
    ;(ctrl as any).runtime = mockRuntime

    const [a, b] = await Promise.all([
      ctrl.handleCreateSession("Concurrent A"),
      ctrl.handleCreateSession("Concurrent B"),
    ])
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).not.toBe(b)
    expect(service.listSessions()).toHaveLength(2)
    expect(service.getSession(a!)?.trueforgeSessionId).not.toBe(service.getSession(b!)?.trueforgeSessionId)
    expect(mockRuntime.callCount()).toBe(2)
  })
})
