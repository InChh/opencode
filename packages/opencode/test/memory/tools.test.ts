import { describe, test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Memory } from "../../src/memory/memory"
import { MemoryStorage } from "../../src/memory/storage"
import { tmpdir } from "../fixture/fixture"

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  return Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await MemoryStorage.clear()
      return fn()
    },
  })
}

describe("Memory Tools", () => {
  describe("MemoryRememberTool", () => {
    test("should save a memory via tool execute", async () => {
      await withInstance(async () => {
        const { MemoryRememberTool } = await import("../../src/memory/tool/remember")
        const toolInfo = await MemoryRememberTool.init()
        const result = await toolInfo.execute(
          {
            content: "Always use Hono framework for HTTP",
            category: "tool",
            tags: ["framework", "http"],
          },
          {
            sessionID: "ses_test_remember",
            messages: [
              { role: "user", content: "What framework should I use?" },
              { role: "assistant", content: "I recommend Hono." },
            ],
          } as any,
        )

        expect(result.title).toContain("Remembered")
        expect(result.output).toContain("Hono")
        expect(result.metadata.memoryID).toBeTruthy()

        // Verify memory was actually created
        const memories = await Memory.list()
        expect(memories.length).toBe(1)
        expect(memories[0].content).toBe("Always use Hono framework for HTTP")
        expect(memories[0].category).toBe("tool")
        expect(memories[0].tags).toEqual(["framework", "http"])
      })
    })

    test("should use context category", async () => {
      await withInstance(async () => {
        const { MemoryRememberTool } = await import("../../src/memory/tool/remember")
        const toolInfo = await MemoryRememberTool.init()
        const result = await toolInfo.execute(
          {
            content: "No semicolons in the project",
            category: "style",
          },
          { sessionID: "ses_style", messages: [] } as any,
        )

        expect(result.title).toContain("style")
        const memories = await Memory.list()
        expect(memories[0].category).toBe("style")
      })
    })
  })

  describe("MemoryForgetTool", () => {
    test("should delete memory by ID", async () => {
      await withInstance(async () => {
        const mem = await Memory.create({
          content: "Old preference",
          category: "style",
          scope: "personal",
          tags: ["old"],
          source: { sessionID: "ses_old", method: "manual" },
        })

        const { MemoryForgetTool } = await import("../../src/memory/tool/forget")
        const toolInfo = await MemoryForgetTool.init()
        const result = await toolInfo.execute(
          { id: mem.id },
          { sessionID: "ses_forget" } as any,
        )

        expect(result.output).toContain("Deleted memory")
        expect(result.output).toContain(mem.id)

        const remaining = await Memory.list()
        expect(remaining.length).toBe(0)
      })
    })

    test("should search and delete single match", async () => {
      await withInstance(async () => {
        await Memory.create({
          content: "Use Express for routing",
          category: "tool",
          scope: "personal",
          tags: ["express"],
          source: { sessionID: "ses1", method: "manual" },
        })

        const { MemoryForgetTool } = await import("../../src/memory/tool/forget")
        const toolInfo = await MemoryForgetTool.init()
        const result = await toolInfo.execute(
          { search: "Express" },
          { sessionID: "ses_forget" } as any,
        )

        expect(result.output).toContain("Deleted memory")
        const remaining = await Memory.list()
        expect(remaining.length).toBe(0)
      })
    })

    test("should list multiple matches for user to choose", async () => {
      await withInstance(async () => {
        await Memory.create({
          content: "Use React for frontend",
          category: "tool",
          scope: "personal",
          tags: ["react"],
          source: { sessionID: "ses1", method: "manual" },
        })
        await Memory.create({
          content: "Use React Testing Library for tests",
          category: "tool",
          scope: "personal",
          tags: ["react", "testing"],
          source: { sessionID: "ses2", method: "manual" },
        })

        const { MemoryForgetTool } = await import("../../src/memory/tool/forget")
        const toolInfo = await MemoryForgetTool.init()
        const result = await toolInfo.execute(
          { search: "React" },
          { sessionID: "ses_forget" } as any,
        )

        expect(result.title).toContain("2 matches")
        expect(result.output).toContain("Please specify the memory ID")

        const remaining = await Memory.list()
        expect(remaining.length).toBe(2)
      })
    })

    test("should handle not found by ID", async () => {
      await withInstance(async () => {
        const { MemoryForgetTool } = await import("../../src/memory/tool/forget")
        const toolInfo = await MemoryForgetTool.init()
        const result = await toolInfo.execute(
          { id: "mem_nonexistent" },
          { sessionID: "ses_forget" } as any,
        )

        expect(result.title).toBe("Memory not found")
      })
    })

    test("should handle no search matches", async () => {
      await withInstance(async () => {
        const { MemoryForgetTool } = await import("../../src/memory/tool/forget")
        const toolInfo = await MemoryForgetTool.init()
        const result = await toolInfo.execute(
          { search: "doesnotexist" },
          { sessionID: "ses_forget" } as any,
        )

        expect(result.title).toBe("No matches")
      })
    })

    test("should handle missing input", async () => {
      await withInstance(async () => {
        const { MemoryForgetTool } = await import("../../src/memory/tool/forget")
        const toolInfo = await MemoryForgetTool.init()
        const result = await toolInfo.execute(
          {},
          { sessionID: "ses_forget" } as any,
        )

        expect(result.title).toBe("Missing input")
      })
    })
  })

  describe("MemoryListTool", () => {
    test("should list all memories", async () => {
      await withInstance(async () => {
        await Memory.create({
          content: "Use Hono",
          category: "tool",
          scope: "personal",
          tags: [],
          source: { sessionID: "ses1", method: "manual" },
        })
        await Memory.create({
          content: "No semicolons",
          category: "style",
          scope: "personal",
          tags: [],
          source: { sessionID: "ses2", method: "manual" },
        })

        const { MemoryListTool } = await import("../../src/memory/tool/memory-list")
        const toolInfo = await MemoryListTool.init()
        const result = await toolInfo.execute({}, {} as any)

        expect(result.title).toBe("2 memories")
        expect(result.metadata.count).toBe(2)
        expect(result.output).toContain("Use Hono")
        expect(result.output).toContain("No semicolons")
      })
    })

    test("should filter by category", async () => {
      await withInstance(async () => {
        await Memory.create({
          content: "Use Hono",
          category: "tool",
          scope: "personal",
          tags: [],
          source: { sessionID: "ses1", method: "manual" },
        })
        await Memory.create({
          content: "No semicolons",
          category: "style",
          scope: "personal",
          tags: [],
          source: { sessionID: "ses2", method: "manual" },
        })

        const { MemoryListTool } = await import("../../src/memory/tool/memory-list")
        const toolInfo = await MemoryListTool.init()
        const result = await toolInfo.execute({ category: "style" }, {} as any)

        expect(result.title).toBe("1 memories")
        expect(result.output).toContain("No semicolons")
        expect(result.output).not.toContain("Use Hono")
      })
    })

    test("should return empty message when no memories", async () => {
      await withInstance(async () => {
        const { MemoryListTool } = await import("../../src/memory/tool/memory-list")
        const toolInfo = await MemoryListTool.init()
        const result = await toolInfo.execute({}, {} as any)

        expect(result.title).toBe("No memories")
        expect(result.metadata.count).toBe(0)
      })
    })
  })
})
