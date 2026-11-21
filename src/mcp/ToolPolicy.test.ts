import { describe, expect, it } from "vitest"
import { assertToolExecutionAllowed, getToolPolicy, toolPolicies } from "./ToolPolicy"

describe("MCP tool policy", () => {
  it("classifies read-only and approval-required tools explicitly", () => {
    expect(toolPolicies).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "list_workspace", access: "read-only" }),
      expect.objectContaining({ name: "apply_hunk", access: "approval-required" }),
      expect.objectContaining({ name: "run_command", access: "approval-required" }),
    ]))
    expect(getToolPolicy("list_workspace").access).toBe("read-only")
    expect(getToolPolicy("apply_hunk").access).toBe("approval-required")
  })

  it("allows read-only tools and rejects missing, mismatched or denied mutation approvals", () => {
    expect(() => assertToolExecutionAllowed("list_workspace")).not.toThrow()
    expect(() => assertToolExecutionAllowed("apply_hunk")).toThrow("Explicit approval")
    expect(() =>
      assertToolExecutionAllowed("apply_hunk", { toolName: "list_workspace", approved: true }),
    ).toThrow("Explicit approval")
    expect(() =>
      assertToolExecutionAllowed("apply_hunk", { toolName: "apply_hunk", approved: false, reason: "declined" }),
    ).toThrow("Explicit approval")
    expect(() =>
      assertToolExecutionAllowed("apply_hunk", { toolName: "apply_hunk", approved: true }),
    ).not.toThrow()
  })
})

