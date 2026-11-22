import type { ContextCandidate } from "./ContextSelector"

/** A #file or @symbol reference resolved by the webview attachment picker. */
export interface PromptAttachment {
  type: "file" | "symbol"
  path: string
  label: string
  startLine?: number
  endLine?: number
}

/** A PromptAttachment with its workspace content loaded and bounded. */
export interface ResolvedAttachment extends PromptAttachment {
  content: string
}

export interface PromptAssembly {
  selected: Array<{ candidate: ContextCandidate }>
  retrieved: Array<{ path: string; text: string; startLine: number; endLine: number }>
}

/** Same estimate used by retrieved evidence: ~4 characters per token. */
export function attachmentTokenEstimate(content: string): number {
  return Math.ceil(content.length / 4)
}

/**
 * Formats the user prompt with explicitly selected context blocks, retrieved
 * workspace evidence and user-attached files or symbols. Pure formatting —
 * the caller is responsible for loading and bounding file content.
 */
export function formatPromptWithContext(
  prompt: string,
  assembly: PromptAssembly,
  attachments: ResolvedAttachment[] = [],
): string {
  const selected = assembly.selected
    .map(({ candidate }) => `### ${candidate.block.title}\n${candidate.block.content}`)
    .join("\n\n")
  const retrieved = assembly.retrieved
    .map(({ path, text, startLine, endLine }) => `### ${path}:${startLine}-${endLine}\n${text}`)
    .join("\n\n")
  const attached = attachments
    .map(({ type, path, label, content, startLine, endLine }) => {
      const location = startLine !== undefined ? `:${startLine}-${endLine ?? startLine}` : ""
      return `### ${label} (${type} ${path}${location})\n${content}`
    })
    .join("\n\n")
  const sections = [selected, retrieved, attached].filter(Boolean)
  if (sections.length === 0) {
    return prompt
  }
  return `${prompt}\n\n<context>\n${sections.join("\n\n")}\n</context>`
}
