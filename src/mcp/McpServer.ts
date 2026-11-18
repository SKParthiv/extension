import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"
import { WorkspaceTools, type WorkspaceToolsOptions } from "./WorkspaceTools"

export interface McpServerInfo {
  host: "127.0.0.1"
  port: number
  url: string
  token: string
}

export interface LocalMcpServerOptions extends WorkspaceToolsOptions {
  port?: number
  token?: string
}

export class LocalMcpServer {
  private readonly token: string
  private readonly port: number
  private readonly workspaceTools: WorkspaceTools
  private httpServer: Server | undefined
  private info: McpServerInfo | undefined

  public constructor(options: LocalMcpServerOptions = { workspaceRoot: process.cwd() }) {
    this.token = options.token ?? randomBytes(32).toString("hex")
    this.port = options.port ?? 8765
    this.workspaceTools = new WorkspaceTools(options)
  }

  public async start(): Promise<McpServerInfo> {
    if (this.httpServer && this.info) {
      return this.info
    }

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
      server.listen(this.port, "127.0.0.1")
    }).catch(async (error) => {
      this.httpServer = undefined
      await this.closeHttpServer(server)
      throw new Error(
        `Unable to bind the MCP server to 127.0.0.1:${this.port}. ` +
          "Choose a different trueforge.mcpPort or stop the process using that port.",
        { cause: error },
      )
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
    if (server) {
      await this.closeHttpServer(server)
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== "/mcp") {
      response.writeHead(404, { "content-type": "text/plain" }).end("Not found")
      return
    }
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      response
        .writeHead(401, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "Unauthorized" }))
      return
    }

    const mcp = this.createMcpServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    try {
      await mcp.connect(transport)
      await transport.handleRequest(request, response)
    } catch (error) {
      if (!response.headersSent) {
        response
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      } else if (!response.writableEnded) {
        response.end()
      }
    } finally {
      await transport.close().catch(() => undefined)
      await mcp.close().catch(() => undefined)
    }
  }

  private createMcpServer(): McpServer {
    const server = new McpServer({
      name: "trueforge-context-agent",
      version: "0.1.0",
    })

    server.registerTool(
      "list_workspace",
      {
        description: "List bounded files under the active workspace. Results use cursor pagination.",
        inputSchema: {
          path: z.string().optional(),
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ path, cursor, limit }) => ({
        content: [{ type: "text", text: JSON.stringify(await this.workspaceTools.listWorkspace(path, cursor, limit)) }],
      }),
    )

    server.registerTool(
      "read_file",
      {
        description: "Read a bounded file or line range from the active workspace.",
        inputSchema: {
          path: z.string(),
          startLine: z.number().int().min(1).optional(),
          endLine: z.number().int().min(1).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ path, startLine, endLine }) => ({
        content: [{ type: "text", text: JSON.stringify(await this.workspaceTools.readFile(path, startLine, endLine)) }],
      }),
    )

    server.registerTool(
      "search_workspace",
      {
        description: "Search source, tests, configuration and documentation in the workspace.",
        inputSchema: {
          query: z.string().min(1).max(500),
          path: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ query, path, limit }) => ({
        content: [{ type: "text", text: JSON.stringify(await this.workspaceTools.searchWorkspace(query, path, limit)) }],
      }),
    )

    server.registerTool(
      "get_symbols",
      {
        description: "Return symbols from the active workspace when a VS Code symbol provider is configured.",
        inputSchema: { path: z.string().optional(), query: z.string().optional() },
        annotations: { readOnlyHint: true },
      },
      async ({ path, query }) => ({
        content: [{ type: "text", text: JSON.stringify(await this.workspaceTools.getSymbols(path, query)) }],
      }),
    )

    server.registerTool(
      "retrieve_context",
      {
        description: "Retrieve ranked evidence for a requirement clause under an explicit budget.",
        inputSchema: {
          query: z.string().min(1).max(1000),
          budget: z.number().int().min(1).max(20000).optional(),
          maxResults: z.number().int().min(1).max(50).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ query, budget, maxResults }) => ({
        content: [{ type: "text", text: JSON.stringify(await this.workspaceTools.retrieveContext(query, budget, maxResults)) }],
      }),
    )

    server.registerTool(
      "propose_changes",
      {
        description: "Stage file changes for review without writing them to disk.",
        inputSchema: {
          changes: z.array(
            z.object({
              path: z.string(),
              proposedText: z.string().max(200000),
            }),
          ).min(1).max(20),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ changes }) => ({
        content: [{ type: "text", text: JSON.stringify(await this.workspaceTools.proposeChanges(changes)) }],
      }),
    )

    server.registerTool(
      "apply_hunk",
      {
        description: "Apply one previously proposed hunk after the editor has approved it.",
        inputSchema: {
          proposalId: z.string(),
          hunkId: z.string(),
        },
        annotations: { destructiveHint: true },
      },
      async ({ proposalId, hunkId }) => ({
        content: [{ type: "text", text: JSON.stringify(await this.workspaceTools.applyHunk(proposalId, hunkId)) }],
      }),
    )

    server.registerTool(
      "run_command",
      {
        description: "Run an approved workspace-scoped command.",
        inputSchema: { command: z.string().min(1).max(2000), approved: z.boolean().optional() },
        annotations: { destructiveHint: true },
      },
      async ({ command, approved }) => ({
        content: [{ type: "text", text: JSON.stringify(await this.workspaceTools.runCommand(command, approved === true)) }],
      }),
    )

    return server
  }

  private async closeHttpServer(server: Server): Promise<void> {
    if (!server.listening) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}
