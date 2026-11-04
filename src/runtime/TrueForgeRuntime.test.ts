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
})
