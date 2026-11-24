import { createHash } from "node:crypto"

export interface EditHunk {
  id: string
  originalStart: number
  originalLines: string[]
  proposedStart: number
  proposedLines: string[]
  approved: boolean
}

export interface EditProposal {
  filePath: string
  originalText: string
  originalHash?: string
  proposedText: string
  hunks: EditHunk[]
  expectedHash?: string
  expectedText?: string
}

export function computeHash(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

export function createEditProposal(
  filePath: string,
  originalText: string,
  proposedText: string,
  originalHash?: string,
): EditProposal {
  const original = splitLines(originalText)
  const proposed = splitLines(proposedText)
  const operations = diffLines(original, proposed)
  const hunks: EditHunk[] = []
  let originalIndex = 0
  let proposedIndex = 0
  let hunkIndex = 0

  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index].kind === "equal") {
      originalIndex += 1
      proposedIndex += 1
      continue
    }

    const originalStart = originalIndex + 1
    const proposedStart = proposedIndex + 1
    const originalLines: string[] = []
    const proposedLines: string[] = []
    while (index < operations.length && operations[index].kind !== "equal") {
      const operation = operations[index]
      if (operation.kind === "delete") {
        originalLines.push(operation.line)
        originalIndex += 1
      } else {
        proposedLines.push(operation.line)
        proposedIndex += 1
      }
      index += 1
    }
    index -= 1
    hunks.push({
      id: `${filePath}:${hunkIndex}`,
      originalStart,
      originalLines,
      proposedStart,
      proposedLines,
      approved: false,
    })
    hunkIndex += 1
  }

  const hash = originalHash ?? computeHash(originalText)
  return {
    filePath,
    originalText,
    originalHash: hash,
    proposedText,
    hunks,
    expectedHash: hash,
    expectedText: originalText,
  }
}

export function approveHunk(proposal: EditProposal, hunkId: string): EditProposal {
  return updateHunkApproval(proposal, hunkId, true)
}

export function rejectHunk(proposal: EditProposal, hunkId: string): EditProposal {
  return updateHunkApproval(proposal, hunkId, false)
}

export function applyApprovedHunks(proposal: EditProposal): string {
  const original = splitLines(proposal.originalText)
  const approved = new Set(proposal.hunks.filter((hunk) => hunk.approved).map((hunk) => hunk.id))
  const operations = diffLines(original, splitLines(proposal.proposedText))
  const result: string[] = []
  let originalIndex = 0
  let hunkIndex = 0

  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index].kind === "equal") {
      result.push(operations[index].line)
      originalIndex += 1
      continue
    }

    const hunkId = `${proposal.filePath}:${hunkIndex}`
    const operationLines: string[] = []
    while (index < operations.length && operations[index].kind !== "equal") {
      operationLines.push(operations[index].kind === "delete" ? `-${operations[index].line}` : `+${operations[index].line}`)
      index += 1
    }
    index -= 1
    if (approved.has(hunkId)) {
      for (const line of operationLines) {
        if (line.startsWith("+")) {
          result.push(line.slice(1))
        }
      }
    } else {
      for (const line of operationLines) {
        if (line.startsWith("-")) {
          result.push(line.slice(1))
        }
      }
    }
    hunkIndex += 1
  }

  return joinLines(result, proposal.originalText)
}

function updateHunkApproval(proposal: EditProposal, hunkId: string, approved: boolean): EditProposal {
  let found = false
  const hunks = proposal.hunks.map((hunk) => {
    if (hunk.id !== hunkId) {
      return hunk
    }
    found = true
    return { ...hunk, approved }
  })
  if (!found) {
    throw new Error(`Unknown edit hunk: ${hunkId}`)
  }
  return { ...proposal, hunks }
}

type Operation = { kind: "equal" | "delete" | "insert"; line: string }

function diffLines(original: string[], proposed: string[]): Operation[] {
  const table: number[][] = Array.from({ length: original.length + 1 }, () =>
    Array<number>(proposed.length + 1).fill(0),
  )
  for (let originalIndex = original.length - 1; originalIndex >= 0; originalIndex -= 1) {
    for (let proposedIndex = proposed.length - 1; proposedIndex >= 0; proposedIndex -= 1) {
      table[originalIndex][proposedIndex] =
        original[originalIndex] === proposed[proposedIndex]
          ? table[originalIndex + 1][proposedIndex + 1] + 1
          : Math.max(table[originalIndex + 1][proposedIndex], table[originalIndex][proposedIndex + 1])
    }
  }

  const operations: Operation[] = []
  let originalIndex = 0
  let proposedIndex = 0
  while (originalIndex < original.length || proposedIndex < proposed.length) {
    if (
      originalIndex < original.length &&
      proposedIndex < proposed.length &&
      original[originalIndex] === proposed[proposedIndex]
    ) {
      operations.push({ kind: "equal", line: original[originalIndex] })
      originalIndex += 1
      proposedIndex += 1
    } else if (
      proposedIndex < proposed.length &&
      (originalIndex === original.length || table[originalIndex][proposedIndex + 1] >= table[originalIndex + 1][proposedIndex])
    ) {
      operations.push({ kind: "insert", line: proposed[proposedIndex] })
      proposedIndex += 1
    } else {
      operations.push({ kind: "delete", line: original[originalIndex] })
      originalIndex += 1
    }
  }
  return operations
}

function splitLines(value: string): string[] {
  if (value === "") {
    return []
  }
  const lines = value.split(/\r?\n/)
  if (value.endsWith("\n")) {
    lines.pop()
  }
  return lines
}

function joinLines(lines: string[], originalText: string): string {
  const newline = originalText.includes("\r\n") ? "\r\n" : "\n"
  const trailingNewline = originalText.endsWith("\n") ? newline : ""
  return lines.join(newline) + trailingNewline
}
