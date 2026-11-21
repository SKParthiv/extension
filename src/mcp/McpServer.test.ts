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

  it("supports repeated stateless initialization and tool discovery", async () => {
    const server = new LocalMcpServer({ workspaceRoot: process.cwd(), port: 0 })
    const info = await server.start()
    try {
      const headers = {
        authorization: `Bearer ${info.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      }
      const initialize = await fetch(info.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          },
        }),
      })
      expect(initialize.status).toBe(200)
      expect(await readSseJson(initialize)).toMatchObject({ result: { serverInfo: { name: "trueforge-context-agent" } } })
      const tools = await fetch(info.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      })
      expect(tools.status).toBe(200)
      const body = (await readSseJson(tools)) as { result?: { tools?: Array<{ name: string }> } }
      expect(body.result?.tools?.map((tool) => tool.name)).toEqual([
        "list_workspace",
        "read_file",
        "search_workspace",
        "get_symbols",
        "retrieve_context",
        "propose_changes",
        "apply_hunk",
        "run_command",
      ])
      const read = await fetch(info.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "read_file", arguments: { path: "package.json", startLine: 1, endLine: 1 } },
        }),
      })
      expect(read.status).toBe(200)
      expect(await readSseJson(read)).toMatchObject({ result: { content: [{ type: "text" }] } })
      const repeatedRead = await fetch(info.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "read_file", arguments: { path: "package.json", startLine: 1, endLine: 1 } },
        }),
      })
      expect(repeatedRead.status).toBe(200)
    } finally {
      await server.stop()
    }
  })
})

async function readSseJson(response: Response): Promise<unknown> {
  const text = await response.text()
  const data = text
    .split(/\r?\n/)
    .find((line) => line.startsWith("data: "))
  if (!data) throw new Error(`Missing SSE data: ${text}`)
  return JSON.parse(data.slice("data: ".length))
}

