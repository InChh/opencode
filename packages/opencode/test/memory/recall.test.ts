import { afterEach, describe, expect, it, spyOn, test } from "bun:test"
import { MemoryRecall } from "../../src/memory/engine/recall"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir } from "../fixture/fixture"
import type { Memory } from "../../src/memory/memory"
import { MemoryHindsightRecall } from "../../src/memory/hindsight/recall"

type Hindsight = {
  enabled: boolean
  mode: "embedded"
  extract: boolean
  recall: boolean
  backfill: boolean
  workspace_scope: "worktree"
  context_max_items: number
  context_max_tokens: number
}

function cfg(input: Partial<Hindsight> = {}) {
  return {
    enabled: true,
    mode: "embedded" as const,
    extract: true,
    recall: true,
    backfill: true,
    workspace_scope: "worktree" as const,
    context_max_items: 6,
    context_max_tokens: 1200,
    ...input,
  }
}

function mem(id: string): Memory.Info {
  const now = Date.now()
  return {
    id,
    content: `memory ${id}`,
    categories: ["context"],
    scope: "personal",
    status: "confirmed",
    tags: [],
    citations: [],
    score: 1,
    baseScore: 1,
    useCount: 0,
    hitCount: 0,
    source: { sessionID: "s", method: "manual" },
    createdAt: now,
    updatedAt: now,
    inject: false,
  }
}

describe("MemoryRecall", () => {
  describe("Result schema", () => {
    it("should validate a valid recall result", () => {
      const data = {
        relevant: ["mem_abc", "mem_def"],
        conflicts: [{ memoryA: "mem_abc", memoryB: "mem_def", reason: "Conflicting framework choice" }],
      }
      const parsed = MemoryRecall.Result.parse(data)
      expect(parsed.relevant).toHaveLength(2)
      expect(parsed.conflicts).toHaveLength(1)
      expect(parsed.conflicts[0].reason).toBe("Conflicting framework choice")
    })

    it("should validate empty recall result", () => {
      const parsed = MemoryRecall.Result.parse({ relevant: [], conflicts: [] })
      expect(parsed.relevant).toHaveLength(0)
      expect(parsed.conflicts).toHaveLength(0)
    })

    it("should reject missing fields", () => {
      expect(() => MemoryRecall.Result.parse({})).toThrow()
      expect(() => MemoryRecall.Result.parse({ relevant: [] })).toThrow()
    })

    it("should reject invalid conflict structure", () => {
      expect(() => MemoryRecall.Result.parse({ relevant: [], conflicts: [{ memoryA: "x" }] })).toThrow()
    })
  })

  describe("invoke — hindsight ranking", () => {
    const spies: Array<ReturnType<typeof spyOn>> = []

    afterEach(async () => {
      for (const spy of spies) spy.mockRestore()
      spies.length = 0
      await Instance.disposeAll()
    })

    test("passes hindsight-ranked candidates with rank and score hints", async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          memory: {
            hindsight: cfg(),
          },
        },
      })

      let sys = ""
      spies.push(
        spyOn(Provider, "defaultModel").mockResolvedValue({
          providerID: "test",
          modelID: "primary",
        }),
        spyOn(Provider, "getSmallModel").mockResolvedValue(undefined),
        spyOn(MemoryHindsightRecall, "query").mockResolvedValue({
          raw: { results: [] } as never,
          hits: 2,
          candidates: [
            {
              memory: mem("mem_2"),
              memory_id: "mem_2",
              document_id: "doc_2",
              rank: 1,
              score: 0.99,
              reason: "document_id",
            },
            {
              memory: mem("mem_1"),
              memory_id: "mem_1",
              document_id: "doc_1",
              rank: 3,
              score: 0.87,
              reason: "metadata",
            },
          ],
          drops: [],
        }),
        spyOn(SessionPrompt, "prompt").mockImplementation((async (opts) => {
          sys = opts.system ?? ""
          return {
            info: {} as never,
            parts: [{ type: "text", text: JSON.stringify({ relevant: ["mem_2"], conflicts: [] }) }],
          }
        }) as typeof SessionPrompt.prompt),
      )

      const result = await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          return MemoryRecall.invoke({
            sessionID: session.id,
            memories: [mem("mem_1"), mem("mem_2")],
            recentMessages: [{ role: "user", content: "Which memory matters now?" }],
          })
        },
      })

      expect(result).toEqual({ relevant: ["mem_2"], conflicts: [] })
      expect(sys).toContain('"id":"mem_2"')
      expect(sys).toContain('"rank":1')
      expect(sys).toContain('"score":0.99')
      expect(sys).toContain('"id":"mem_1"')
      expect(sys).toContain('"rank":3')
      expect(sys).toContain('"score":0.87')
    })

    test("falls back to the full pool when hindsight returns no candidates", async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          memory: {
            hindsight: cfg(),
          },
        },
      })

      let sys = ""
      spies.push(
        spyOn(Provider, "defaultModel").mockResolvedValue({
          providerID: "test",
          modelID: "primary",
        }),
        spyOn(Provider, "getSmallModel").mockResolvedValue(undefined),
        spyOn(MemoryHindsightRecall, "query").mockResolvedValue({
          raw: { results: [] } as never,
          hits: 0,
          candidates: [],
          drops: [],
        }),
        spyOn(SessionPrompt, "prompt").mockImplementation((async (opts) => {
          sys = opts.system ?? ""
          return {
            info: {} as never,
            parts: [{ type: "text", text: JSON.stringify({ relevant: ["mem_1", "mem_2"], conflicts: [] }) }],
          }
        }) as typeof SessionPrompt.prompt),
      )

      const result = await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          return MemoryRecall.invoke({
            sessionID: session.id,
            memories: [mem("mem_1"), mem("mem_2")],
            recentMessages: [{ role: "user", content: "hello" }],
          })
        },
      })

      expect(result).toEqual({ relevant: ["mem_1", "mem_2"], conflicts: [] })
      expect(sys).toContain('"id":"mem_1"')
      expect(sys).toContain('"id":"mem_2"')
      expect(sys).not.toContain('"rank"')
      expect(sys).not.toContain('"score":0.99')
    })

    test("falls back to the full pool when hindsight query throws", async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          memory: {
            hindsight: cfg(),
          },
        },
      })

      let sys = ""
      spies.push(
        spyOn(Provider, "defaultModel").mockResolvedValue({
          providerID: "test",
          modelID: "primary",
        }),
        spyOn(Provider, "getSmallModel").mockResolvedValue(undefined),
        spyOn(MemoryHindsightRecall, "query").mockRejectedValue(new Error("boom")),
        spyOn(SessionPrompt, "prompt").mockImplementation((async (opts) => {
          sys = opts.system ?? ""
          return {
            info: {} as never,
            parts: [{ type: "text", text: JSON.stringify({ relevant: ["mem_1"], conflicts: [] }) }],
          }
        }) as typeof SessionPrompt.prompt),
      )

      const result = await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          return MemoryRecall.invoke({
            sessionID: session.id,
            memories: [mem("mem_1"), mem("mem_2")],
            recentMessages: [{ role: "user", content: "hello" }],
          })
        },
      })

      expect(result).toEqual({ relevant: ["mem_1"], conflicts: [] })
      expect(sys).toContain('"id":"mem_1"')
      expect(sys).toContain('"id":"mem_2"')
      expect(sys).not.toContain('"rank"')
      expect(sys).not.toContain('"score"')
    })
  })

  describe("invoke — error paths", () => {
    const spies: Array<ReturnType<typeof spyOn>> = []

    afterEach(() => {
      for (const s of spies) s.mockRestore()
      spies.length = 0
    })

    const input = {
      sessionID: "ses_test",
      memories: [mem("mem_1"), mem("mem_2")],
      recentMessages: [{ role: "user", content: "hello" }],
    }

    test("fallback when Config.get() throws", async () => {
      // No stubs → Config.get() fails → catch → fallback
      const result = await MemoryRecall.invoke(input)
      expect(result.relevant).toEqual(["mem_1", "mem_2"])
      expect(result.conflicts).toEqual([])
    }, 15000)

    test("fallback when Provider.defaultModel() throws", async () => {
      spies.push(
        spyOn(Config, "get").mockResolvedValue({ memory: {} } as any),
        spyOn(Provider, "defaultModel").mockRejectedValue(new Error("no provider")),
      )
      const result = await MemoryRecall.invoke(input)
      expect(result.relevant).toEqual(["mem_1", "mem_2"])
      expect(result.conflicts).toEqual([])
    })

    test("sync throw in Config.get() still returns fallback", async () => {
      spies.push(
        spyOn(Config, "get").mockImplementation(() => {
          throw new Error("sync boom")
        }),
      )
      const result = await MemoryRecall.invoke(input)
      expect(result.relevant).toEqual(["mem_1", "mem_2"])
      expect(result.conflicts).toEqual([])
    })
  })
})
