import { describe, test, expect } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Memory } from "../../src/memory/memory"
import { MemoryStorage } from "../../src/memory/storage"
import { MemoryConfirmation } from "../../src/memory/engine/confirmation"
import { tmpdir } from "../fixture/fixture"

async function withMemoryEnv<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  return Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await MemoryStorage.clear()
      return fn()
    },
  })
}

function makeInput(content: string) {
  return {
    content,
    categories: ["pattern"] as ("pattern" | "context" | "tool" | "style" | "domain" | "workflow" | "correction")[],
    scope: "personal" as const,
    source: { sessionID: "ses_test", method: "manual" as const },
  }
}

describe("MemoryConfirmation", () => {
  describe("checkPendingMemories", () => {
    test("confirms memory that meets both criteria (age + hits)", async () => {
      await withMemoryEnv(async () => {
        const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
        const memory = await Memory.create(makeInput("Use bun test for testing"))
        // Memory.update() excludes createdAt from patches, so we use MemoryStorage.save() directly
        const patched = { ...memory, status: "pending", createdAt: eightDaysAgo, hitCount: 3 }
        await MemoryStorage.save(patched)

        const confirmed = await MemoryConfirmation.checkPendingMemories()
        expect(confirmed).toBe(1)

        const updated = await Memory.get(memory.id)
        expect(updated?.status).toBe("confirmed")
      })
    })

    test("does not confirm memory that is too young", async () => {
      await withMemoryEnv(async () => {
        const memory = await Memory.create(makeInput("Recent memory"))
        await Memory.update(memory.id, { status: "pending", hitCount: 5 })

        const confirmed = await MemoryConfirmation.checkPendingMemories()
        expect(confirmed).toBe(0)

        const updated = await Memory.get(memory.id)
        expect(updated?.status).toBe("pending")
      })
    })

    test("does not confirm memory with too few hits", async () => {
      await withMemoryEnv(async () => {
        const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000
        const memory = await Memory.create(makeInput("Old memory low hits"))
        const patched = { ...memory, status: "pending", createdAt: tenDaysAgo, hitCount: 1 }
        await MemoryStorage.save(patched)

        const confirmed = await MemoryConfirmation.checkPendingMemories()
        expect(confirmed).toBe(0)
      })
    })

    test("skips already confirmed memories", async () => {
      await withMemoryEnv(async () => {
        const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000
        const memory = await Memory.create(makeInput("Already confirmed"))
        const patched = { ...memory, status: "confirmed", createdAt: tenDaysAgo, hitCount: 10 }
        await MemoryStorage.save(patched)

        const confirmed = await MemoryConfirmation.checkPendingMemories()
        expect(confirmed).toBe(0)
      })
    })

    test("confirms multiple memories in one pass", async () => {
      await withMemoryEnv(async () => {
        const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000

        for (let i = 0; i < 3; i++) {
          const m = await Memory.create(makeInput(`Memory ${i}`))
          const patched = { ...m, status: "pending", createdAt: tenDaysAgo, hitCount: 3 }
          await MemoryStorage.save(patched)
        }

        const confirmed = await MemoryConfirmation.checkPendingMemories()
        expect(confirmed).toBe(3)
      })
    })

    test("returns 0 when no pending memories exist", async () => {
      await withMemoryEnv(async () => {
        const confirmed = await MemoryConfirmation.checkPendingMemories()
        expect(confirmed).toBe(0)
      })
    })
  })
})
