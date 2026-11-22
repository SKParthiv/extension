import { describe, expect, it } from "vitest"
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "./messages"

describe("message bridge contracts", () => {
  it("accepts only the declared bridge shapes", () => {
    const inbound = { type: "ready", viewId: "chat" } satisfies WebviewToExtensionMessage
    const outbound = { type: "runtimeStatus", status: "idle" } satisfies ExtensionToWebviewMessage

    expect(inbound.type).toBe("ready")
    expect(outbound.status).toBe("idle")
  })
})

