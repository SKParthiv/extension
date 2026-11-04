import { describe, expect, it } from "vitest"
import { LocalMcpServer } from "./McpServer"

describe("LocalMcpServer", () => {
  it("rejects requests without the per-launch bearer token", async () => {
    const server = new LocalMcpServer()
    const info = await server.start()
    try {
      const response = await fetch(info.url, { method: "POST", body: "{}" })
      expect(response.status).toBe(401)
    } finally {
      await server.stop()
    }
  })

  it("binds to loopback and releases its ephemeral port", async () => {
    const server = new LocalMcpServer()
    const info = await server.start()
    expect(info.host).toBe("127.0.0.1")
    expect(info.port).toBeGreaterThan(0)
    await server.stop()

    await expect(fetch(info.url, { method: "POST", body: "{}" })).rejects.toThrow()
  })
})

