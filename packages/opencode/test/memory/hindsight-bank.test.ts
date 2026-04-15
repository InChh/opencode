import { describe, expect, test } from "bun:test"
import { MemoryHindsightBank } from "../../src/memory/hindsight/bank"

describe("MemoryHindsightBank", () => {
  test("builds stable worktree-scoped bank ids", () => {
    const a = "/tmp/opencode/worktree-a"
    const b = "/tmp/opencode/worktree-b"

    expect(MemoryHindsightBank.worktreeHash(a)).toBe(MemoryHindsightBank.worktreeHash(a))
    expect(MemoryHindsightBank.worktreeHash(a)).not.toBe(MemoryHindsightBank.worktreeHash(b))
    expect(MemoryHindsightBank.bankId(a)).toBe(`opencode:${MemoryHindsightBank.worktreeHash(a)}`)
    expect(MemoryHindsightBank.bankId(b)).toBe(`opencode:${MemoryHindsightBank.worktreeHash(b)}`)
  })
})
