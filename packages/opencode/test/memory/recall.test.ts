import { describe, it, expect } from "bun:test"
import { MemoryRecall } from "../../src/memory/engine/recall"

describe("MemoryRecall", () => {
  describe("Result schema", () => {
    it("should validate a valid recall result", () => {
      const data = {
        relevant: ["mem_abc", "mem_def"],
        conflicts: [
          {
            memoryA: "mem_abc",
            memoryB: "mem_def",
            reason: "Conflicting framework choice",
          },
        ],
      }
      const parsed = MemoryRecall.Result.parse(data)
      expect(parsed.relevant).toHaveLength(2)
      expect(parsed.conflicts).toHaveLength(1)
      expect(parsed.conflicts[0].reason).toBe("Conflicting framework choice")
    })

    it("should validate empty recall result", () => {
      const data = {
        relevant: [],
        conflicts: [],
      }
      const parsed = MemoryRecall.Result.parse(data)
      expect(parsed.relevant).toHaveLength(0)
      expect(parsed.conflicts).toHaveLength(0)
    })

    it("should reject missing fields", () => {
      expect(() => MemoryRecall.Result.parse({})).toThrow()
      expect(() => MemoryRecall.Result.parse({ relevant: [] })).toThrow()
    })

    it("should reject invalid conflict structure", () => {
      expect(() =>
        MemoryRecall.Result.parse({
          relevant: [],
          conflicts: [{ memoryA: "x" }],
        }),
      ).toThrow()
    })
  })

  // NOTE: invoke() requires LLM provider connection and cannot be unit tested.
  // Integration tests should be added when a mock LLM provider is available.
})
