import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { promisify } from "node:util"
import { retrieveLocalText } from "../context/LocalRetriever"
import { assertCommandAllowed } from "../tools/CommandPolicy"

const execFileAsync = promisify(execFile)
const MAX_FILE_BYTES = 200_000
const MAX_OUTPUT_CHARS = 30_000
const DEFAULT_IGNORED = new Set([".git", "node_modules", "out", "dist", "coverage", ".vscode-test"])

export interface ProposedChange {
  path: string
  originalText: string
  originalHash: string
  proposedText: string
}

export interface WorkspaceToolsOptions {
  workspaceRoot: string
  symbolProvider?: (path?: string, query?: string) => Promise<unknown>
  runCommand?: (command: string) => Promise<string>
  applyHunk?: (proposal: ProposedChange, hunkId: string) => Promise<unknown>
}

export class WorkspaceTools {
  private readonly proposals = new Map<string, ProposedChange>()
  private readonly options: WorkspaceToolsOptions

  public constructor(options: WorkspaceToolsOptions) {
    this.options = options
  }

  public async listWorkspace(relativePath = "", cursor = "0", limit = 50) {
    const files = await this.collectFiles(relativePath)
    const start = parseCursor(cursor)
    const items = files.slice(start, start + limit)
    return {
      files: items.map((file) => ({ path: path.relative(this.options.workspaceRoot, file).replaceAll(path.sep, "/") })),
      nextCursor: start + items.length < files.length ? String(start + items.length) : undefined,
    }
  }

  public async readFile(relativePath: string, startLine = 1, endLine?: number) {
    const filePath = await this.resolveFile(relativePath)
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte read limit: ${relativePath}`)
    }
    const content = await fs.readFile(filePath, "utf8")
    const lines = content.split(/\r?\n/)
    const end = Math.min(endLine ?? lines.length, lines.length)
    if (startLine > end) {
      throw new Error("startLine must not be greater than endLine.")
    }
    return {
      path: path.relative(this.options.workspaceRoot, filePath).replaceAll(path.sep, "/"),
      startLine,
      endLine: end,
      content: lines.slice(startLine - 1, end).join("\n"),
      sha256: hash(content),
    }
  }

  public async searchWorkspace(query: string, relativePath = "", limit = 50) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const matches: Array<{ path: string; line: number; text: string }> = []
    for (const file of await this.collectFiles(relativePath)) {
      const stat = await fs.stat(file)
      if (stat.size > MAX_FILE_BYTES) continue
      const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/)
      lines.forEach((line, index) => {
        const lower = line.toLowerCase()
        if (terms.every((term) => lower.includes(term))) {
          matches.push({ path: this.relative(file), line: index + 1, text: line.slice(0, 1000) })
        }
      })
      if (matches.length >= limit) break
    }
    return { query, matches: matches.slice(0, limit) }
  }

  public async getSymbols(relativePath?: string, query?: string) {
    if (!this.options.symbolProvider) {
      return { available: false, reason: "No VS Code symbol provider is configured for this MCP server." }
    }
    return this.options.symbolProvider(relativePath, query)
  }

  public async retrieveContext(query: string, budget = 4000, maxResults = 12) {
    const files = await this.collectFiles("")
    const searchFiles = []
    for (const file of files) {
      const stat = await fs.stat(file)
      if (stat.size <= MAX_FILE_BYTES) {
        searchFiles.push({ path: this.relative(file), content: await fs.readFile(file, "utf8") })
      }
    }
    const snippets = retrieveLocalText(query, searchFiles, {
      maxFiles: maxResults,
      maxResults,
      maxCharsPerFile: Math.max(200, Math.floor((budget * 4) / Math.max(maxResults, 1))),
    })
    return {
      budget,
      usedEstimate: snippets.reduce((total, item) => total + Math.ceil(item.text.length / 4), 0),
      snippets,
    }
  }

  public async proposeChanges(changes: Array<{ path: string; proposedText: string }>) {
    const proposals = []
    for (const change of changes) {
      const filePath = await this.resolveFile(change.path)
      const originalText = await fs.readFile(filePath, "utf8")
      const id = hash(`${change.path}:${originalText}:${change.proposedText}`).slice(0, 16)
      this.proposals.set(id, {
        path: change.path,
        originalText,
        originalHash: hash(originalText),
        proposedText: change.proposedText,
      })
      proposals.push({ id, path: change.path, originalHash: hash(originalText), changed: originalText !== change.proposedText })
    }
    return { proposals }
  }

  public async applyHunk(proposalId: string, hunkId: string) {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`)
    if (!this.options.applyHunk) {
      throw new Error("The extension has not configured the approved VS Code edit callback.")
    }
    const result = await this.options.applyHunk(proposal, hunkId)
    this.proposals.delete(proposalId)
    return result
  }

  public async runCommand(command: string, approved: boolean) {
    assertCommandAllowed(command, approved)
    if (this.options.runCommand) {
      return { output: truncate(await this.options.runCommand(command)), access: "approved" }
    }
    const result = await execFileAsync(process.platform === "win32" ? "powershell.exe" : "sh",
      process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command],
      { cwd: this.options.workspaceRoot, maxBuffer: 1_000_000 })
    return { output: truncate(`${result.stdout}${result.stderr}`), access: approved ? "approved" : "read-only" }
  }

  private async collectFiles(relativePath: string): Promise<string[]> {
    const root = await this.resolveDirectory(relativePath)
    const files: string[] = []
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".") && entry.name !== ".rst") continue
        if (entry.isDirectory() && DEFAULT_IGNORED.has(entry.name)) continue
        const fullPath = path.join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) await visit(fullPath)
        else if (entry.isFile() && !this.isIgnored(fullPath)) files.push(fullPath)
      }
    }
    await visit(root)
    return files.sort((left, right) => left.localeCompare(right))
  }

  private isIgnored(filePath: string): boolean {
    const relative = this.relative(filePath)
    return relative.split("/").some((part) => DEFAULT_IGNORED.has(part))
  }

  private async resolveDirectory(relativePath: string): Promise<string> {
    const resolved = await this.resolvePath(relativePath)
    const stat = await fs.stat(resolved)
    if (!stat.isDirectory()) throw new Error(`Workspace path is not a directory: ${relativePath}`)
    return resolved
  }

  private async resolveFile(relativePath: string): Promise<string> {
    const resolved = await this.resolvePath(relativePath)
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) throw new Error(`Workspace path is not a file: ${relativePath}`)
    return resolved
  }

  private async resolvePath(relativePath: string): Promise<string> {
    if (path.isAbsolute(relativePath)) throw new Error("Workspace paths must be relative.")
    const candidate = path.resolve(this.options.workspaceRoot, relativePath)
    const root = await fs.realpath(this.options.workspaceRoot)
    const existing = await fs.realpath(candidate).catch(() => candidate)
    if (existing !== root && !existing.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Workspace path escapes the active workspace: ${relativePath}`)
    }
    return candidate
  }

  private relative(filePath: string): string {
    return path.relative(this.options.workspaceRoot, filePath).replaceAll(path.sep, "/")
  }
}

function parseCursor(cursor: string): number {
  const parsed = Number.parseInt(cursor, 10)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error("cursor must be a non-negative integer.")
  return parsed
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function truncate(value: string): string {
  return value.length > MAX_OUTPUT_CHARS ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]` : value
}
