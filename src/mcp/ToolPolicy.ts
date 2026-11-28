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
    name: "list_workspace",
    access: "read-only",
    description: "Lists workspace files.",
  },
  {
    name: "read_file",
    access: "read-only",
    description: "Reads a bounded workspace file.",
  },
  {
    name: "search_workspace",
    access: "read-only",
    description: "Searches workspace text.",
  },
  {
    name: "get_symbols",
    access: "read-only",
    description: "Returns workspace symbols.",
  },
  {
    name: "retrieve_context",
    access: "read-only",
    description: "Retrieves ranked workspace evidence.",
  },
  {
    name: "propose_changes",
    access: "read-only",
    description: "Stages changes without writing to disk.",
  },
  {
    name: "apply_hunk",
    access: "approval-required",
    description: "Applies one approved change hunk.",
  },
  {
    name: "run_command",
    access: "approval-required",
    description: "Runs a workspace-scoped command.",
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

