import type { ContextBlock, ContextPriority, SessionMembership } from "./ContextService"

export interface ContextCandidate {
  block: ContextBlock
  membership: SessionMembership
}

export interface SelectedContext {
  candidate: ContextCandidate
  reason: "pinned" | "priority" | "position"
}

export interface ContextSelection {
  budget: number
  usedTokens: number
  selected: SelectedContext[]
  omitted: Array<{ candidate: ContextCandidate; reason: "budget" }>
}

export function isEligibleContext(candidate: ContextCandidate): boolean {
  return candidate.membership.status === "active"
}

export function selectContext(candidates: ContextCandidate[], budget: number): ContextSelection {
  if (!Number.isInteger(budget) || budget < 0) {
    throw new Error("Context budget must be a non-negative integer.")
  }

  const eligible = candidates.filter(isEligibleContext)
  const ordered = [...eligible].sort(compareCandidates)
  const selected: SelectedContext[] = []
  const omitted: ContextSelection["omitted"] = []
  let usedTokens = 0

  for (const candidate of ordered) {
    const pinned = candidate.membership.pinned
    const tokenEstimate = Math.max(0, candidate.block.tokenEstimate)
    if (pinned || usedTokens + tokenEstimate <= budget) {
      selected.push({
        candidate,
        reason: pinned ? "pinned" : candidate.membership.priority ? "priority" : "position",
      })
      usedTokens += tokenEstimate
    } else {
      omitted.push({ candidate, reason: "budget" })
    }
  }

  return { budget, usedTokens, selected, omitted }
}

function compareCandidates(left: ContextCandidate, right: ContextCandidate): number {
  if (left.membership.pinned !== right.membership.pinned) {
    return left.membership.pinned ? -1 : 1
  }
  const priority = priorityRank(left.membership.priority) - priorityRank(right.membership.priority)
  if (priority !== 0) {
    return priority
  }
  if (left.membership.position !== right.membership.position) {
    return left.membership.position - right.membership.position
  }
  return left.block.id.localeCompare(right.block.id)
}

function priorityRank(priority: ContextPriority | null): number {
  return priority ? Number(priority.slice(1)) : 4
}
