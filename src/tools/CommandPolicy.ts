export type CommandAccess = "read-only" | "approval-required" | "blocked"

export interface CommandAssessment {
  command: string
  access: CommandAccess
  reason: string
}

const blockedPatterns: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bformat\s+[a-z]:/i, reason: "Disk formatting is blocked." },
  { pattern: /\b(del|erase|rm)\s+(-rf\s+)?[\\/]/i, reason: "Root-level deletion is blocked." },
]

const approvalPatterns: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(remove-item|rm|del|erase|rmdir)\b/i, reason: "Deletion changes workspace state." },
  { pattern: /\b(move-item|mv|rename-item|ren)\b/i, reason: "Move or rename changes workspace state." },
  { pattern: /\b(copy-item|cp|copy)\b/i, reason: "Copy changes workspace state." },
  { pattern: /\b(set-content|add-content|out-file|tee|>\s*)\b/i, reason: "File writes change workspace state." },
  { pattern: /\b(npm\s+(install|uninstall)|pip\s+install|winget\s+install)\b/i, reason: "Package installation changes the environment." },
]

export function assessCommand(command: string): CommandAssessment {
  const normalized = command.trim()
  if (!normalized) {
    throw new Error("Command cannot be empty.")
  }
  const blocked = blockedPatterns.find(({ pattern }) => pattern.test(normalized))
  if (blocked) {
    return { command: normalized, access: "blocked", reason: blocked.reason }
  }
  const approval = approvalPatterns.find(({ pattern }) => pattern.test(normalized))
  if (approval) {
    return { command: normalized, access: "approval-required", reason: approval.reason }
  }
  return {
    command: normalized,
    access: "read-only",
    reason: "No workspace-mutating pattern was detected.",
  }
}

export function assertCommandAllowed(command: string, approved = false): void {
  const assessment = assessCommand(command)
  if (assessment.access === "blocked") {
    throw new Error(assessment.reason)
  }
  if (assessment.access === "approval-required" && !approved) {
    throw new Error(`Explicit approval is required: ${assessment.reason}`)
  }
}

