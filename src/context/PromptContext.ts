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
 * Maximum characters allowed per single attachment content.
 */
export const MAX_CHARS_PER_ATTACHMENT = 2400

/**
 * Allocate budget to explicit attachments in selection order.
 * Each attachment is capped to MAX_CHARS_PER_ATTACHMENT characters.
 * Returns allocated attachments with token estimates, truncation flags,
 * and any attachment that was fully omitted due to budget exhaustion.
 * Never silently discards an attachment — every one is reported.
 */
export function assignAttachmentBudget(
  attachments: ResolvedAttachment[],
  availableTokens: number,
): {
  allocated: Array<{
    resolved: ResolvedAttachment
    tokenEstimate: number
    truncated: boolean
    reason: "attachment" | "truncated" | "omitted"
  }>
  usedTokens: number
} {
  const allocated: Array<{
    resolved: ResolvedAttachment
    tokenEstimate: number
    truncated: boolean
    reason: "attachment" | "truncated" | "omitted"
  }> = []
  let usedTokens = 0
  for (const a of attachments) {
    const rawChars = a.content.length
    const boundedChars = Math.min(rawChars, MAX_CHARS_PER_ATTACHMENT)
    const boundedTokens = attachmentTokenEstimate(a.content.slice(0, boundedChars))
    const truncated = boundedChars < rawChars
    const fits = usedTokens + boundedTokens <= availableTokens
    if (!fits) {
      // Attachment omitted — still report it
      allocated.push({
        resolved: a,
        tokenEstimate: boundedTokens,
        truncated: false,
        reason: "omitted",
      })
      continue
    }
    allocated.push({
      resolved: truncated ? { ...a, content: a.content.slice(0, boundedChars) } : a,
      tokenEstimate: boundedTokens,
      truncated,
      reason: "attachment",
    })
    usedTokens += boundedTokens
  }
  return { allocated, usedTokens }
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
