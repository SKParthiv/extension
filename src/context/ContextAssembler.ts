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
  const retrieved =
    input.query && input.files
      ? retrieveLocalText(input.query, input.files, input.retrieval)
      : []

  return {
    budget: input.budget,
    selected: selection.selected,
    omitted: selection.omitted,
    conflicts: detectConflicts(input.candidates),
    retrieved,
  }
}

