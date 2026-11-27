import { detectConflicts, type ContextConflict } from "./ContextConflicts"
import { retrieveLocalText, type RetrievedSnippet, type SearchFile } from "./LocalRetriever"
import { selectContext, type ContextCandidate, type ContextSelection } from "./ContextSelector"
import { assignAttachmentBudget, type ResolvedAttachment, MAX_CHARS_PER_ATTACHMENT } from "./PromptContext"

export interface ContextAssemblyInput {
  candidates: ContextCandidate[]
  query?: string
  files?: SearchFile[]
  budget: number
  /** Pre-loaded resolved attachments (content already fetched from workspace). */
  attachments?: ResolvedAttachment[]
  retrieval?: {
    maxFiles?: number
    maxCharsPerFile?: number
    maxResults?: number
  }
}

export interface ContextAssembly {
  budget: number
  usedTokens: number
  selected: ContextSelection["selected"]
  omitted: ContextSelection["omitted"]
  conflicts: ContextConflict[]
  retrieved: RetrievedSnippet[]
  attachments: Array<{
    resolved: ResolvedAttachment
    tokenEstimate: number
    truncated: boolean
    reason: "attachment" | "truncated" | "omitted"
  }>
}

export function assembleContext(input: ContextAssemblyInput): ContextAssembly {
  const selection = selectContext(input.candidates, input.budget)
  const usedSelected = selection.usedTokens
  let remainingForAttachments = Math.max(input.budget - usedSelected, 0)

  // Allocate to attachments
  const attachmentResult = assignAttachmentBudget(input.attachments ?? [], remainingForAttachments)
  const usedAttachments = attachmentResult.usedTokens
  const remainingForRetrieval = Math.max(remainingForAttachments - usedAttachments, 0)

  // Allocate to retrieved evidence
  let accumulatedTokens = 0
  const retrieved =
    input.query && input.files
      ? retrieveLocalText(input.query, input.files, {
          ...input.retrieval,
          maxCharsPerFile: Math.max(
            200,
            Math.floor((remainingForRetrieval * 4) / Math.max(input.retrieval?.maxResults ?? 12, 1)),
          ),
        }).filter((snippet) => {
          const tokens = Math.ceil(snippet.text.length / 4)
          if (accumulatedTokens + tokens <= remainingForRetrieval) {
            accumulatedTokens += tokens
            return true
          }
          return false
        })
      : []

  return {
    budget: input.budget,
    usedTokens: usedSelected + usedAttachments + accumulatedTokens,
    selected: selection.selected,
    omitted: selection.omitted,
    conflicts: detectConflicts(input.candidates),
    retrieved,
    attachments: attachmentResult.allocated,
  }
}

