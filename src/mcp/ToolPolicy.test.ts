import { describe, expect, it } from "vitest"
import { assertToolExecutionAllowed, getToolPolicy, toolPolicies } from "./ToolPolicy"

describe("MCP tool policy", () => {
  it("classifies read-only and approval-required tools explicitly", () => {
    expect(toolPolicies).toEqual([
      { name: "echo", access: "read-only", description: "Returns supplied text without side effects." },
      {
        name: "echo_write",
        access: "approval-required",
        description: "Mutation-capable tools require an explicit approval decision.",
      },
    ])
    expect(getToolPolicy("echo").access).toBe("read-only")
    expect(getToolPolicy("echo_write").access).toBe("approval-required")
  })

  it("allows read-only tools and rejects missing, mismatched or denied mutation approvals", () => {
    expect(() => assertToolExecutionAllowed("echo")).not.toThrow()
    expect(() => assertToolExecutionAllowed("echo_write")).toThrow("Explicit approval")
    expect(() =>
      assertToolExecutionAllowed("echo_write", { toolName: "echo", approved: true }),
    ).toThrow("Explicit approval")
    expect(() =>
      assertToolExecutionAllowed("echo_write", { toolName: "echo_write", approved: false, reason: "declined" }),
    ).toThrow("Explicit approval")
    expect(() =>
      assertToolExecutionAllowed("echo_write", { toolName: "echo_write", approved: true }),
    ).not.toThrow()
  })
})

