import { detectConflicts, type ContextConflict } from "./ContextConflicts"
import { retrieveLocalText, type RetrievedSnippet, type SearchFile } from "./LocalRetriever"
import { selectContext, type ContextCandidate, type ContextSelection } from "./ContextSelector"

export interface ContextAssemblyInput {
  candidates: ContextCandidate[]
  query?: string
  files?: SearchFile[]
  budget: number
  retrieval?: {
    maxFiles?: number
    maxCharsPerFile?: number
    maxResults?: number
  }
}

export interface ContextAssembly {
  budget: number
  selected: ContextSelection["selected"]
  omitted: ContextSelection["omitted"]
  conflicts: ContextConflict[]
  retrieved: RetrievedSnippet[]
}

export function assembleContext(input: ContextAssemblyInput): ContextAssembly {
  const selection = selectContext(input.candidates, input.budget)
  const selectedTokens = selection.selected.reduce((sum, item) => sum + item.candidate.block.tokenEstimate, 0)
  const remainingBudget = Math.max(input.budget - selectedTokens, 0)
  let accumulatedTokens = 0
  const retrieved =
    input.query && input.files
      ? retrieveLocalText(input.query, input.files, {
          ...input.retrieval,
          maxCharsPerFile: Math.max(
            200,
            Math.floor((remainingBudget * 4) / Math.max(input.retrieval?.maxResults ?? 12, 1)),
          ),
        }).filter((snippet) => {
          const tokens = Math.ceil(snippet.text.length / 4)
          if (accumulatedTokens + tokens <= remainingBudget) {
            accumulatedTokens += tokens
            return true
          }
          return false
        })
      : []

  return {
    budget: input.budget,
    selected: selection.selected,
    omitted: selection.omitted,
    conflicts: detectConflicts(input.candidates),
    retrieved,
  }
}

