import type { ContextCandidate } from "./ContextSelector"

export interface ContextConflict {
  key: string
  left: ContextCandidate
  right: ContextCandidate
  reason: "different-values"
}

export function detectConflicts(candidates: ContextCandidate[]): ContextConflict[] {
  const directives = new Map<string, Array<{ candidate: ContextCandidate; value: string }>>()

  for (const candidate of candidates) {
    for (const directive of extractDirectives(candidate.block.content)) {
      const entries = directives.get(directive.key) ?? []
      entries.push({ candidate, value: directive.value })
      directives.set(directive.key, entries)
    }
  }

  const conflicts: ContextConflict[] = []
  for (const [key, entries] of directives) {
    for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
        const left = entries[leftIndex]
        const right = entries[rightIndex]
        if (left.value !== right.value) {
          const [first, second] =
            left.candidate.block.id.localeCompare(right.candidate.block.id) <= 0 ? [left, right] : [right, left]
          conflicts.push({
            key,
            left: first.candidate,
            right: second.candidate,
            reason: "different-values",
          })
        }
      }
    }
  }

  return conflicts.sort((left, right) => {
    const keyOrder = left.key.localeCompare(right.key)
    if (keyOrder !== 0) {
      return keyOrder
    }
    return left.left.block.id.localeCompare(right.left.block.id)
  })
}

function extractDirectives(content: string): Array<{ key: string; value: string }> {
  const directives: Array<{ key: string; value: string }> = []
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_.-]*)\s*(?::|=)\s*(.+?)\s*$/.exec(line)
    if (!match) {
      continue
    }
    directives.push({
      key: match[1].toLowerCase(),
      value: match[2].trim(),
    })
  }
  return directives
}
