import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"

export interface McpServerInfo {
  host: "127.0.0.1"
  port: number
  url: string
  token: string
}

export class LocalMcpServer {
  private readonly token = randomBytes(32).toString("hex")
  private readonly mcp = new McpServer({
    name: "trueforge-context-agent",
    version: "0.1.0",
  })
  private readonly transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })
  private httpServer: Server | undefined
  private info: McpServerInfo | undefined

  public constructor() {
    this.mcp.registerTool(
      "echo",
      {
        description: "Return the supplied text without side effects.",
        inputSchema: { text: z.string().max(4000) },
      },
      async ({ text }) => ({
        content: [{ type: "text", text }],
      }),
    )

    this.mcp.registerTool(
      "echo_write",
      {
        description: "Approval-gated write-mode echo. It has no side effect in this server.",
        inputSchema: { text: z.string().max(4000) },
      },
      async ({ text }) => ({
        content: [{ type: "text", text: `approval-gated echo: ${text}` }],
      }),
    )
  }

  public async start(): Promise<McpServerInfo> {
    if (this.httpServer && this.info) {
      return this.info
    }

    await this.mcp.connect(this.transport)
    const server = createServer((request, response) => {
      void this.handleRequest(request, response)
    })
    this.httpServer = server

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening)
        reject(error)
      }
      const onListening = () => {
        server.off("error", onError)
        resolve()
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(0, "127.0.0.1")
    })

    const address = server.address()
    if (!address || typeof address === "string") {
      await this.stop()
      throw new Error("MCP server did not receive a TCP address.")
    }
    this.info = {
      host: "127.0.0.1",
      port: address.port,
      url: `http://127.0.0.1:${address.port}/mcp`,
      token: this.token,
    }
    return this.info
  }

  public async stop(): Promise<void> {
    const server = this.httpServer
    this.httpServer = undefined
    this.info = undefined

    await this.transport.close().catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes("closed")) {
        throw error
      }
    })
    await this.mcp.close().catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes("closed")) {
        throw error
      }
    })

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== "/mcp") {
      response.writeHead(404).end("Not found")
      return
    }
    const authorization = request.headers.authorization
    if (authorization !== `Bearer ${this.token}`) {
      response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }))
      return
    }
    await this.transport.handleRequest(request, response)
  }
}

