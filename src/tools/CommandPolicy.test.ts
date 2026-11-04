import { describe, expect, it } from "vitest"
import { assertCommandAllowed, assessCommand } from "./CommandPolicy"

describe("command policy", () => {
  it("allows inspection commands without approval", () => {
    expect(assessCommand("git status")).toMatchObject({ access: "read-only" })
    expect(() => assertCommandAllowed("Get-ChildItem")).not.toThrow()
  })

  it("requires approval for mutations and blocks destructive root operations", () => {
    expect(assessCommand("Remove-Item notes.txt")).toMatchObject({ access: "approval-required" })
    expect(() => assertCommandAllowed("Remove-Item notes.txt")).toThrow("Explicit approval")
    expect(() => assertCommandAllowed("Remove-Item notes.txt", true)).not.toThrow()
    expect(assessCommand("rm -rf /")).toMatchObject({ access: "blocked" })
    expect(() => assertCommandAllowed("rm -rf /", true)).toThrow("blocked")
  })

  it("rejects empty commands", () => {
    expect(() => assessCommand("  ")).toThrow("empty")
  })
})

