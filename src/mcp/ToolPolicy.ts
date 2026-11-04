export type ToolAccess = "read-only" | "approval-required"

export interface ToolPolicy {
  name: string
  access: ToolAccess
  description: string
}

export interface ToolApproval {
  toolName: string
  approved: boolean
  reason?: string
}

export const toolPolicies: ToolPolicy[] = [
  {
    name: "echo",
    access: "read-only",
    description: "Returns supplied text without side effects.",
  },
  {
    name: "echo_write",
    access: "approval-required",
    description: "Mutation-capable tools require an explicit approval decision.",
  },
]

export function getToolPolicy(toolName: string): ToolPolicy {
  const policy = toolPolicies.find((item) => item.name === toolName)
  if (!policy) {
    throw new Error(`Unknown MCP tool: ${toolName}`)
  }
  return policy
}

export function assertToolExecutionAllowed(toolName: string, approval?: ToolApproval): void {
  const policy = getToolPolicy(toolName)
  if (policy.access === "read-only") {
    return
  }
  if (!approval || approval.toolName !== toolName || !approval.approved) {
    throw new Error(`Explicit approval is required before executing ${toolName}.`)
  }
}

