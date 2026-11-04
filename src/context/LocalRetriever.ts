export interface SearchFile {
  path: string
  content: string
}

export interface RetrievedSnippet {
  path: string
  text: string
  score: number
  reason: string
  startLine: number
  endLine: number
}

export interface RetrievalOptions {
  maxFiles?: number
  maxCharsPerFile?: number
  maxResults?: number
}

export function retrieveLocalText(
  query: string,
  files: SearchFile[],
  options: RetrievalOptions = {},
): RetrievedSnippet[] {
  const terms = tokenize(query)
  if (terms.length === 0) {
    return []
  }
  const maxFiles = options.maxFiles ?? 8
  const maxCharsPerFile = options.maxCharsPerFile ?? 1200
  const maxResults = options.maxResults ?? maxFiles
  if (maxFiles < 1 || maxCharsPerFile < 1 || maxResults < 1) {
    throw new Error("Retrieval limits must be positive integers.")
  }

  return files
    .map((file) => scoreFile(file, terms, maxCharsPerFile))
    .filter((result): result is RetrievedSnippet => result !== undefined)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, Math.min(maxFiles, maxResults))
}

function scoreFile(file: SearchFile, terms: string[], maxCharsPerFile: number): RetrievedSnippet | undefined {
  const lowerContent = file.content.toLowerCase()
  const matches = terms.filter((term) => lowerContent.includes(term))
  if (matches.length === 0) {
    return undefined
  }

  const firstMatch = Math.min(...matches.map((term) => lowerContent.indexOf(term)))
  const halfWindow = Math.floor(maxCharsPerFile / 2)
  const start = Math.max(0, firstMatch - halfWindow)
  const end = Math.min(file.content.length, start + maxCharsPerFile)
  const text = file.content.slice(start, end)
  const startLine = file.content.slice(0, start).split(/\r?\n/).length
  const endLine = startLine + text.split(/\r?\n/).length - 1
  const score = matches.reduce((total, term) => total + countOccurrences(lowerContent, term), 0)

  return {
    path: file.path,
    text,
    score,
    reason: `Matched ${matches.length} of ${terms.length} query terms.`,
    startLine,
    endLine,
  }
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [])]
}

function countOccurrences(value: string, term: string): number {
  let count = 0
  let index = value.indexOf(term)
  while (index >= 0) {
    count += 1
    index = value.indexOf(term, index + term.length)
  }
  return count
}

