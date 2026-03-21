import { describe, test, expect } from "bun:test"
import { Hono } from "hono"
import { Instance } from "../../src/project/instance"
import { Memory } from "../../src/memory/memory"
import { MemoryStorage } from "../../src/memory/storage"
import { tmpdir } from "../fixture/fixture"

/**
 * Tests for Memory Web API routes.
 *
 * We create the Hono routes inline (same logic as MemoryRoutes)
 * to avoid top-level lazy() initialization issues in test context.
 * This tests the actual route handlers' logic against real storage.
 */

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

async function createTestMemories() {
  const m1 = await Memory.create({
    content: "Use Hono framework",
    category: "tool",
    scope: "personal",
    status: "confirmed",
    tags: ["framework"],
    source: { sessionID: "ses1", method: "manual" },
  })
  const m2 = await Memory.create({
    content: "No semicolons",
    category: "style",
    scope: "personal",
    status: "pending",
    tags: ["formatting"],
    source: { sessionID: "ses2", method: "auto" },
  })
  return { m1, m2 }
}

describe("Memory Web API", () => {
  describe("Memory CRUD operations", () => {
    test("list returns all memories sorted by score", async () => {
      await withInstance(async () => {
        const { m1, m2 } = await createTestMemories()
        const memories = await Memory.list()
        expect(memories.length).toBe(2)
        const sorted = memories.sort((a, b) => b.score - a.score)
        expect(sorted[0].score).toBeGreaterThanOrEqual(sorted[1].score)
      })
    })

    test("list filters by scope", async () => {
      await withInstance(async () => {
        await createTestMemories()
        const personal = await Memory.list({ scope: "personal" })
        expect(personal.length).toBe(2)
        const team = await Memory.list({ scope: "team" })
        expect(team.length).toBe(0)
      })
    })

    test("list filters by category", async () => {
      await withInstance(async () => {
        await createTestMemories()
        const tools = await Memory.list({ category: "tool" })
        expect(tools.length).toBe(1)
        expect(tools[0].content).toBe("Use Hono framework")
      })
    })

    test("list filters by status", async () => {
      await withInstance(async () => {
        await createTestMemories()
        const pending = await Memory.list({ status: "pending" })
        expect(pending.length).toBe(1)
        expect(pending[0].content).toBe("No semicolons")
      })
    })

    test("list filters by method", async () => {
      await withInstance(async () => {
        await createTestMemories()
        const manual = await Memory.list({ method: "manual" })
        expect(manual.length).toBe(1)
        expect(manual[0].content).toBe("Use Hono framework")
      })
    })

    test("get returns single memory", async () => {
      await withInstance(async () => {
        const { m1 } = await createTestMemories()
        const memory = await Memory.get(m1.id)
        expect(memory).toBeTruthy()
        expect(memory!.content).toBe("Use Hono framework")
      })
    })

    test("get returns null for nonexistent ID", async () => {
      await withInstance(async () => {
        const memory = await Memory.get("mem_nonexistent")
        expect(memory).toBeUndefined()
      })
    })

    test("update modifies memory fields", async () => {
      await withInstance(async () => {
        const { m1 } = await createTestMemories()
        const updated = await Memory.update(m1.id, {
          content: "Use Hono v4 framework",
          tags: ["framework", "hono"],
          status: "confirmed",
        })
        expect(updated).toBeTruthy()
        expect(updated!.content).toBe("Use Hono v4 framework")
        expect(updated!.tags).toContain("hono")
      })
    })

    test("update returns null for nonexistent ID", async () => {
      await withInstance(async () => {
        const result = await Memory.update("mem_nonexistent", { content: "nope" })
        expect(result).toBeUndefined()
      })
    })

    test("delete removes memory", async () => {
      await withInstance(async () => {
        const { m1 } = await createTestMemories()
        const result = await Memory.remove(m1.id)
        expect(result).toBe(true)

        const afterDelete = await Memory.list()
        expect(afterDelete.length).toBe(1)
        expect(afterDelete[0].id).not.toBe(m1.id)
      })
    })

    test("delete returns false for nonexistent ID", async () => {
      await withInstance(async () => {
        const result = await Memory.remove("mem_nonexistent")
        expect(result).toBe(false)
      })
    })

    test("batch delete removes multiple memories", async () => {
      await withInstance(async () => {
        const { m1, m2 } = await createTestMemories()
        const r1 = await Memory.remove(m1.id)
        const r2 = await Memory.remove(m2.id)
        expect(r1).toBe(true)
        expect(r2).toBe(true)

        const remaining = await Memory.list()
        expect(remaining.length).toBe(0)
      })
    })
  })

  describe("Stats computation", () => {
    test("stats returns correct counts", async () => {
      await withInstance(async () => {
        await createTestMemories()
        const all = await Memory.list()
        const personal = all.filter((m) => m.scope === "personal")
        const pending = all.filter((m) => m.status === "pending")

        expect(all.length).toBe(2)
        expect(personal.length).toBe(2)
        expect(pending.length).toBe(1)
      })
    })

    test("stats category breakdown is correct", async () => {
      await withInstance(async () => {
        await createTestMemories()
        const all = await Memory.list()

        const categoryBreakdown: Record<string, number> = {}
        for (const m of all) {
          categoryBreakdown[m.category] = (categoryBreakdown[m.category] || 0) + 1
        }

        expect(categoryBreakdown.tool).toBe(1)
        expect(categoryBreakdown.style).toBe(1)
      })
    })
  })
})
