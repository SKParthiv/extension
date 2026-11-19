import { describe, expect, it, vi } from "vitest"
import { TrueForgeRuntime } from "./TrueForgeRuntime"

describe("TrueForgeRuntime", () => {
  it("creates a named-agent session and maps streamed model events", async () => {
    const createTurnStream = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "turn.created" as const,
          createdAt: "2026-11-04T00:00:00Z",
          id: "event-1",
          input: [],
          previousTurnId: null,
          state: { status: "running" as const },
          threadId: "thread-1",
          turnId: "turn-1",
        }
        yield {
          type: "model.message.delta" as const,
          id: "event-2",
          threadId: "thread-1",
          content: "hello",
        }
        yield {
          type: "turn.done" as const,
          createdAt: "2026-11-04T00:00:01Z",
          id: "event-3",
          state: {
            status: "done" as const,
            completedAt: "2026-11-04T00:00:01Z",
            output: null,
            requiredActions: [],
          },
          threadId: null,
        }
      },
    }))
    const client = {
      sessions: {
        create: vi.fn(async () => ({ data: { id: "session-1" } })),
        createTurnStream,
        cancel: vi.fn(async () => ({})),
      },
    }
    const runtime = new TrueForgeRuntime({
      baseUrl: "http://localhost:8790",
      agentName: "local-agent",
      client,
    })
    const events: string[] = []
    runtime.onEvent((event) => {
      if (event.type === "model.message.delta") {
        events.push(event.text)
      }
    })

    await expect(runtime.createSession()).resolves.toEqual({ id: "session-1" })
    await runtime.sendTurn("session-1", "hello")

    expect(createTurnStream).toHaveBeenCalledWith("session-1", {
      input: [{ type: "user.message", content: "hello" }],
    })
    expect(events).toEqual(["hello"])
  })

  it("defaults to read-only Thinking mode and gates approvals behind Tool mode", async () => {
    const createTurnStream = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "turn.done" as const,
          createdAt: "2026-11-04T00:00:01Z",
          id: "event-1",
          state: { status: "done" as const, completedAt: "2026-11-04T00:00:01Z", output: null, requiredActions: [] },
          threadId: null,
        }
      },
    }))
    const client = {
      sessions: {
        create: vi.fn(async () => ({ data: { id: "session-1" } })),
        createTurnStream,
        cancel: vi.fn(async () => ({})),
      },
    }
    const runtime = new TrueForgeRuntime({
      baseUrl: "http://localhost:8790",
      agentName: "local-agent",
      client,
    })

    expect(runtime.getMode()).toBe("thinking")
    await expect(
      runtime.respondToApproval("session-1", "thread-1", "tool-1", { status: "allow" }),
    ).rejects.toThrow("Thinking mode")

    const modes: string[] = []
    runtime.onEvent((event) => {
      if (event.type === "mode.changed") {
        modes.push(event.mode)
      }
    })
    runtime.setMode("tool")
    expect(runtime.getMode()).toBe("tool")
    expect(modes).toEqual(["tool"])
    await runtime.respondToApproval("session-1", "thread-1", "tool-1", { status: "deny", reason: "test" })
    expect(createTurnStream).toHaveBeenCalled()
  })

  it("forwards cancellation to TrueForge and chains the previous turn", async () => {
    const createTurnStream = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "turn.created" as const,
          createdAt: "2026-11-04T00:00:00Z",
          id: "event-1",
          input: [],
          previousTurnId: null,
          state: { status: "running" as const },
          threadId: "thread-1",
          turnId: "turn-1",
        }
        yield {
          type: "turn.done" as const,
          createdAt: "2026-11-04T00:00:01Z",
          id: "event-2",
          state: { status: "done" as const, completedAt: "2026-11-04T00:00:01Z", output: null, requiredActions: [] },
          threadId: null,
        }
      },
    }))
    const cancel = vi.fn(async () => ({}))
    const client = {
      sessions: {
        create: vi.fn(async () => ({ data: { id: "session-1" } })),
        createTurnStream,
        cancel,
      },
    }
    const runtime = new TrueForgeRuntime({
      baseUrl: "http://localhost:8790",
      agentName: "local-agent",
      client,
    })

    await runtime.sendTurn("session-1", "first")
    await runtime.sendTurn("session-1", "second")
    await runtime.cancel("session-1")

    expect(createTurnStream).toHaveBeenNthCalledWith(2, "session-1", {
      input: [{ type: "user.message", content: "second" }],
      previousTurnId: "turn-1",
    })
    expect(cancel).toHaveBeenCalledWith("session-1")
  })

  it("rejects overlapping turns so streamed responses cannot interleave", async () => {
    let release!: () => void
    const createTurnStream = vi.fn(
      async () =>
        new Promise<AsyncIterable<never>>((resolve) => {
          release = () => resolve({ async *[Symbol.asyncIterator]() {} })
        }),
    )
    const client = {
      sessions: {
        create: vi.fn(async () => ({ data: { id: "session-1" } })),
        createTurnStream,
        cancel: vi.fn(async () => ({})),
      },
    }
    const runtime = new TrueForgeRuntime({
      baseUrl: "http://localhost:8790",
      agentName: "local-agent",
      client,
    })

    const first = runtime.sendTurn("session-1", "first")
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(runtime.sendTurn("session-1", "second")).rejects.toThrow("already running")
    release()
    await first
  })

  it("reports degraded connectivity and permits an explicit session reset", async () => {
    const createTurnStream = vi
      .fn()
      .mockRejectedValueOnce(new Error("TrueForge unavailable"))
      .mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "turn.created" as const,
            createdAt: "2026-11-04T00:00:00Z",
            id: "event-1",
            input: [],
            previousTurnId: null,
            state: { status: "running" as const },
            threadId: "thread-1",
            turnId: "turn-recovered",
          }
          yield {
            type: "turn.done" as const,
            createdAt: "2026-11-04T00:00:01Z",
            id: "event-2",
            state: {
              status: "done" as const,
              completedAt: "2026-11-04T00:00:01Z",
              output: null,
              requiredActions: [],
            },
            threadId: null,
          }
        },
      })
    const client = {
      sessions: {
        create: vi.fn(async () => ({ data: { id: "session-1" } })),
        createTurnStream,
        cancel: vi.fn(async () => ({})),
      },
    }
    const runtime = new TrueForgeRuntime({
      baseUrl: "http://localhost:8790",
      agentName: "local-agent",
      client,
    })
    const states: string[] = []
    runtime.onEvent((event) => {
      if (event.type === "connection.changed") {
        states.push(event.state)
      }
    })

    await runtime.createSession()
    await expect(runtime.sendTurn("session-1", "fails")).rejects.toThrow("unavailable")
    expect(runtime.getConnectionState()).toBe("degraded")

    runtime.resetSession("session-1")
    await runtime.sendTurn("session-1", "recovers")
    expect(createTurnStream).toHaveBeenNthCalledWith(2, "session-1", {
      input: [{ type: "user.message", content: "recovers" }],
    })
    expect(runtime.getConnectionState()).toBe("connected")
    expect(states).toEqual(["connected", "degraded", "connected"])
  })

  it("does not reset a session while its stream is active", async () => {
    let release!: () => void
    const client = {
      sessions: {
        create: vi.fn(async () => ({ data: { id: "session-1" } })),
        createTurnStream: vi.fn(
          async () =>
            new Promise<AsyncIterable<never>>((resolve) => {
              release = () => resolve({ async *[Symbol.asyncIterator]() {} })
            }),
        ),
        cancel: vi.fn(async () => ({})),
      },
    }
    const runtime = new TrueForgeRuntime({
      baseUrl: "http://localhost:8790",
      agentName: "local-agent",
      client,
    })

    const turn = runtime.sendTurn("session-1", "work")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(() => runtime.resetSession("session-1")).toThrow("active session")
    release()
    await turn
  })

  it("enriches tool.approval_required events with tool name, arguments and sessionId", async () => {
    const createTurnStream = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "turn.created" as const,
          createdAt: "2026-11-04T00:00:00Z",
          id: "event-1",
          input: [],
          previousTurnId: null,
          state: { status: "running" as const },
          threadId: "thread-1",
          turnId: "turn-1",
        }
        yield {
          type: "model.message" as const,
          createdAt: "2026-11-04T00:00:01Z",
          id: "evt-model-msg",
          threadId: "thread-1",
          content: "I need to run a command",
          toolCalls: [
            {
              id: "call-1",
              type: "function" as const,
              function: {
                name: "run_command",
                arguments: JSON.stringify({ command: "pytest tests/test_cli.py" }),
              },
              toolInfo: {
                type: "mcp" as const,
                name: "run_command",
                serverId: "srv-1",
                serverName: "trueforge-extension",
              },
            },
          ],
        }
        yield {
          type: "tool.approval_required" as const,
          createdAt: "2026-11-04T00:00:02Z",
          id: "evt-approval",
          threadId: "thread-1",
          toolCalls: [{ id: "call-1", sourceEventId: "evt-model-msg" }],
        }
      },
    }))
    const client = {
      sessions: {
        create: vi.fn(async () => ({ data: { id: "session-42" } })),
        createTurnStream,
        cancel: vi.fn(async () => ({})),
      },
    }
    const runtime = new TrueForgeRuntime({
      baseUrl: "http://localhost:8790",
      agentName: "local-agent",
      client,
    })

    const approvalEvents: any[] = []
    runtime.onEvent((event) => {
      if (event.type === "tool.approval_required") {
        approvalEvents.push(event)
      }
    })

    await runtime.sendTurn("session-42", "run tests")
    expect(approvalEvents).toHaveLength(1)
    expect(approvalEvents[0]).toMatchObject({
      type: "tool.approval_required",
      sessionId: "session-42",
      threadId: "thread-1",
      toolCalls: [
        {
          id: "call-1",
          sourceEventId: "evt-model-msg",
          toolName: "run_command",
          arguments: { command: "pytest tests/test_cli.py" },
        },
      ],
    })
  })
})
